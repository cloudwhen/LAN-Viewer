const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;

const SHARE_DIR = path.join(__dirname, 'shared-files');

if (!fs.existsSync(SHARE_DIR)) {
  fs.mkdirSync(SHARE_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static('public'));

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function getFiles(dir, relativePath = '') {
  const items = [];
  const files = fs.readdirSync(dir);

  files.forEach(file => {
    const fullPath = path.join(dir, file);
    const stats = fs.statSync(fullPath);
    const item = {
      name: file,
      path: path.join(relativePath, file).replace(/\\/g, '/'),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      modified: stats.mtime
    };

    if (item.isDirectory) {
      item.children = getFiles(fullPath, item.path);
    }

    items.push(item);
  });

  return items;
}

async function scanNetworkComputers(segment = null) {
  try {
    if (segment) {
      return await scanNetworkSegment(segment);
    } else {
      return await scanNetworkViaNetView();
    }
  } catch (error) {
    console.error('扫描网络失败:', error);
    return [];
  }
}

async function scanNetworkViaNetView() {
  try {
    const { stdout } = await execAsync('net view');
    const lines = stdout.split('\n');
    const computers = [];

    for (const line of lines) {
      const match = line.match(/^\\\\([^\s]+)/);
      if (match) {
        computers.push({
          name: match[1],
          path: `\\\\${match[1]}`,
          type: 'computer'
        });
      }
    }

    return computers;
  } catch (error) {
    console.error('使用 net view 扫描失败:', error);
    return [];
  }
}

async function scanNetworkSegment(segment) {
  const computers = [];
  const promises = [];

  for (let i = 1; i <= 254; i++) {
    const ip = `${segment}.${i}`;
    promises.push(pingHost(ip));
  }

  const results = await Promise.all(promises);

  for (let i = 0; i < results.length; i++) {
    if (results[i]) {
      const ip = `${segment}.${i + 1}`;
      try {
        const { stdout } = await execAsync(`nbtstat -A ${ip}`);
        const lines = stdout.split('\n');
        let computerName = ip;

        for (const line of lines) {
          const match = line.match(/^\s+<00>\s+UNIQUE\s+([^\s]+)/);
          if (match) {
            computerName = match[1];
            break;
          }
        }

        computers.push({
          name: computerName,
          path: `\\\\${computerName}`,
          ip: ip,
          type: 'computer'
        });
      } catch (error) {
        computers.push({
          name: ip,
          path: `\\\\${ip}`,
          ip: ip,
          type: 'computer'
        });
      }
    }
  }

  return computers;
}

async function pingHost(ip) {
  try {
    const { stdout } = await execAsync(`ping -n 1 -w 200 ${ip}`);
    return stdout.includes('TTL') || stdout.includes('字节=');
  } catch (error) {
    return false;
  }
}

async function getSharedFolders(computerPath) {
  try {
    const { stdout } = await execAsync(`net view "${computerPath}"`);
    const lines = stdout.split('\n');
    const shares = [];

    for (const line of lines) {
      const match = line.match(/^([^\s]+)\s+Disk/);
      if (match && match[1] !== 'Print$' && !match[1].endsWith('$')) {
        shares.push({
          name: match[1],
          path: `${computerPath}\\${match[1]}`,
          type: 'share'
        });
      }
    }

    return shares;
  } catch (error) {
    console.error('获取共享文件夹失败:', error);
    return [];
  }
}

function getNetworkFiles(sharePath, relativePath = '') {
  try {
    const fullPath = path.join(sharePath, relativePath);
    const items = [];

    if (!fs.existsSync(fullPath)) {
      return items;
    }

    const files = fs.readdirSync(fullPath);

    files.forEach(file => {
      const filePath = path.join(fullPath, file);
      try {
        const stats = fs.statSync(filePath);
        const item = {
          name: file,
          path: path.join(relativePath, file).replace(/\\/g, '/'),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modified: stats.mtime
        };

        items.push(item);
      } catch (error) {
        console.error(`无法访问文件 ${file}:`, error.message);
      }
    });

    return items;
  } catch (error) {
    console.error('读取网络文件失败:', error);
    return [];
  }
}

app.get('/api/network/computers', async (req, res) => {
  try {
    const { segment } = req.query;
    const computers = await scanNetworkComputers(segment);
    res.json({ success: true, computers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/network/shares', async (req, res) => {
  try {
    const { computer } = req.query;
    if (!computer) {
      return res.status(400).json({ success: false, error: 'Computer parameter is required' });
    }

    const shares = await getSharedFolders(computer);
    res.json({ success: true, shares });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/network/files', (req, res) => {
  try {
    const { share, path: filePath = '' } = req.query;
    if (!share) {
      return res.status(400).json({ success: false, error: 'Share parameter is required' });
    }

    const files = getNetworkFiles(share, filePath);
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/network/download', (req, res) => {
  try {
    const { share, path: filePath = '' } = req.query;
    if (!share) {
      return res.status(400).json({ success: false, error: 'Share parameter is required' });
    }

    const fullPath = path.join(share, filePath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    if (fs.statSync(fullPath).isDirectory()) {
      return res.status(400).json({ success: false, error: 'Cannot download directory' });
    }

    res.download(fullPath);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/files', (req, res) => {
  try {
    const files = getFiles(SHARE_DIR);
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/files/*', (req, res) => {
  const filePath = req.path.replace('/api/files/', '');
  const fullPath = path.join(SHARE_DIR, filePath);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  if (fs.statSync(fullPath).isDirectory()) {
    try {
      const files = getFiles(fullPath);
      res.json({ success: true, files });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  } else {
    res.download(fullPath);
  }
});

app.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  try {
    const { path: filePath } = req.query;
    const fullPath = path.join(SHARE_DIR, filePath || '');

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }

    const fileName = req.headers['x-file-name'];
    const savePath = path.join(fullPath, fileName);
    fs.writeFileSync(savePath, req.body);

    res.json({ success: true, message: 'File uploaded successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('局域网共享文件查看器已启动！');
  console.log(`本地访问: http://localhost:${PORT}`);
  console.log(`局域网访问: http://${localIP}:${PORT}`);
  console.log(`本地共享目录: ${SHARE_DIR}`);
  console.log('支持局域网计算机扫描和共享文件夹访问');
});