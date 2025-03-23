const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const cluster = require('cluster');
const express = require('express');
const bodyParser = require('body-parser');
const { handleComment } = require('./src/controllers/comments');
const { handleLike } = require('./src/controllers/like');
const { handlePostArticles } = require('./src/controllers/posts');
const handleDelete = require('./src/controllers/delete');
const { handlePiKnow } = require('./src/controllers/piKnow');
const handleLikeEachOther = require('./src/controllers/likeEachOther');
const handleLogin = require('./src/controllers/login');
const { startRotation, stopRotation, rotationProgress } = require('./src/controllers/rotation');
const getPort = require('get-port');
const os = require('os');
const handleLikeEachOtherWithCluster = require('./src/controllers/likeEachOtherCluster');

let mainWindow;
let logWindow;
let expressServer;
let serverPort;
let isSequentialRunning = false;
let shouldStopSequential = false;
let activeClusterManager = null;

// Thiết lập đường dẫn cluster worker
cluster.setupMaster({
    exec: path.join(__dirname, 'src/controllers/worker-processor.js')
});

// Ghi đè console.log để gửi log tới cửa sổ log
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function() {
    const args = Array.from(arguments);
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    if (logWindow && logWindow.webContents) {
        logWindow.webContents.send('new-log', { type: 'info', message });
    }
    originalConsoleLog.apply(console, arguments);
};

console.error = function() {
    const args = Array.from(arguments);
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    if (logWindow && logWindow.webContents) {
        logWindow.webContents.send('new-log', { type: 'error', message });
    }
    originalConsoleError.apply(console, arguments);
};

// Xử lý khi worker gửi message về master
cluster.on('message', (worker, message) => {
    if (message.type === 'log') {
        console.log(`[Worker ${worker.id}] ${message.data}`);
    }
});

// Xử lý khi worker thoát
cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} đã thoát với code: ${code} và signal: ${signal}`);
    // Khởi động lại worker nếu exit không phải do kill chủ động
    if (code !== 0 && !worker.exitedAfterDisconnect) {
        console.log(`Khởi động lại worker ${worker.id}...`);
        cluster.fork();
    }
});

function createLogWindow() {
    logWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: 'Log Viewer',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    logWindow.loadFile('src/views/log.html');
    
    logWindow.on('closed', () => {
        logWindow = null;
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('src/views/mode-select.html');
    
    // Đợi cho đến khi trang load xong mới inject biến SERVER_PORT
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript(`
            window.SERVER_PORT = ${serverPort};
            localStorage.setItem('SERVER_PORT', ${serverPort});
        `);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (logWindow) logWindow.close();
        app.quit();
    });
}

// Khởi động server Express
async function startExpressServer() {
    // Tìm port trống
    const port = await getPort();
    serverPort = port;
    
    // Khởi tạo Express server
    const server = express();
    server.use(bodyParser.json());

    // Xử lý API
    server.post('/execute-tasks', async (req, res) => {
        try {
            console.log('Bắt đầu thực hiện các tác vụ...');
            const { commentCount, likeCount, deleteCount, postCount, piKnow, likeEachOther, login } = req.body;
            let tasks = [];

            if (login > 0) {
                console.log(`Thực hiện đăng nhập ${login} tài khoản...`);
                tasks.push(handleLogin(login));
            }
            if (commentCount > 0) {
                console.log(`Thực hiện comment ${commentCount} lần...`);
                tasks.push(handleComment(commentCount));
            }
            if (likeCount > 0) {
                console.log(`Thực hiện like ${likeCount} lần...`);
                tasks.push(handleLike(likeCount));
            }
            if (deleteCount > 0) {
                console.log(`Thực hiện xóa ${deleteCount} bài...`);
                tasks.push(handleDelete(deleteCount));
            }
            if (postCount > 0) {
                console.log(`Thực hiện đăng ${postCount} bài...`);
                tasks.push(handlePostArticles(postCount));
            }
            if (piKnow > 0) {
                console.log(`Thực hiện comment PiKnow ${piKnow} lần...`);
                tasks.push(handlePiKnow(piKnow));
            }
            if (likeEachOther > 0) {
                console.log(`Thực hiện like chéo ${likeEachOther} lần...`);
                tasks.push(handleLikeEachOtherWithCluster(likeEachOther));
            }

            const results = await Promise.allSettled(tasks);
            const successCount = results.filter(r => r.status === "fulfilled").length;
            const failCount = results.filter(r => r.status === "rejected").length;

            res.json({
                success: true,
                message: `Hoàn thành ${successCount} tác vụ, ${failCount} thất bại.`,
                details: results
            });
        } catch (error) {
            console.error('Lỗi:', error.message);
            res.json({ success: false, message: "Lỗi khi chạy tác vụ.", error: error.message });
        }
    });

    // Endpoint để dừng tiến trình tuần tự
    server.post('/stop-sequential', (req, res) => {
        if (!isSequentialRunning) {
            return res.json({
                success: false,
                message: "Không có tiến trình nào đang chạy"
            });
        }

        shouldStopSequential = true;
        res.json({
            success: true,
            message: "Đã gửi yêu cầu dừng tiến trình"
        });
    });

    // Routes cho chế độ luân phiên
    server.post('/start-rotation', startRotation);
    server.post('/stop-rotation', stopRotation);
    server.get('/rotation-progress', rotationProgress);

    // Thêm route kiểm tra trạng thái cluster
    server.get('/cluster-status', (req, res) => {
        const workers = Object.values(cluster.workers || {}).map(worker => ({
            id: worker.id,
            pid: worker.process.pid,
            state: worker.state
        }));

        res.json({
            success: true,
            isMaster: true,
            workers: workers,
            totalWorkers: workers.length,
            pid: process.pid
        });
    });

    // Thêm endpoint để điều chỉnh số lượng luồng
    server.post('/set-concurrency', (req, res) => {
        try {
            const { concurrencyLimit } = req.body;
            
            if (!concurrencyLimit || typeof concurrencyLimit !== 'number' || concurrencyLimit <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Vui lòng cung cấp giá trị concurrencyLimit hợp lệ (số dương)"
                });
            }

            // Đặt giá trị môi trường
            process.env.MAX_CONCURRENCY = concurrencyLimit.toString();
            console.log(`Đã đặt giá trị MAX_CONCURRENCY = ${concurrencyLimit}`);

            // Nếu đã có ClusterManager đang hoạt động, cập nhật luôn
            if (activeClusterManager) {
                activeClusterManager.setAllWorkerConcurrency(concurrencyLimit);
                console.log(`Đã cập nhật giới hạn luồng cho tất cả worker hiện có`);
            }

            res.json({
                success: true,
                message: `Đã thiết lập giới hạn luồng thành ${concurrencyLimit}`,
                newLimit: concurrencyLimit
            });
        } catch (error) {
            console.error('Lỗi khi thiết lập concurrency:', error);
            res.status(500).json({
                success: false,
                message: "Lỗi xử lý yêu cầu",
                error: error.message
            });
        }
    });

    // Thêm endpoint để lấy thông tin hệ thống
    server.get('/system-info', (req, res) => {
        const cpuCount = os.cpus().length;
        const memoryInfo = {
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            usedMemoryPercent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(2)
        };
        
        // Tính tài nguyên đang dùng
        const processMemory = process.memoryUsage();
        const workerInfo = activeClusterManager 
            ? activeClusterManager.workers.map(w => ({
                id: w.id,
                pid: w.process.pid
            }))
            : [];

        res.json({
            success: true,
            system: {
                cpuCount,
                memoryInfo,
                platform: os.platform(),
                arch: os.arch(),
                uptime: os.uptime(),
                processUptime: process.uptime()
            },
            process: {
                pid: process.pid,
                memoryUsage: {
                    rss: Math.round(processMemory.rss / 1024 / 1024) + ' MB',
                    heapTotal: Math.round(processMemory.heapTotal / 1024 / 1024) + ' MB',
                    heapUsed: Math.round(processMemory.heapUsed / 1024 / 1024) + ' MB'
                }
            },
            workers: {
                count: workerInfo.length,
                concurrencyLimit: process.env.MAX_CONCURRENCY || 'mặc định',
                details: workerInfo
            }
        });
    });

    expressServer = server.listen(port, () => {
        console.log(`Server đang chạy tại port ${port} (PID: ${process.pid})`);
    });
    
    return port;
}

// Chỉ khởi động Electron trong master process
if (cluster.isPrimary) {
    console.log(`Master process ${process.pid} đang chạy`);
    
    app.whenReady().then(async () => {
        // Khởi động Express server trước
        await startExpressServer();
        
        // Sau đó khởi động các cửa sổ Electron
        createMainWindow();
        createLogWindow();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (mainWindow === null) createMainWindow();
        if (logWindow === null) createLogWindow();
    });

    app.on('quit', () => {
        // Đảm bảo tất cả worker processes đều được tắt
        console.log('Đang dừng tất cả worker processes...');
        for (const id in cluster.workers) {
            console.log(`Kết thúc worker ${id}...`);
            cluster.workers[id].kill();
        }
    });
}

// Export biến activeClusterManager để có thể được truy cập từ controllers
global.activeClusterManager = null;

// Xuất các biến toàn cục
module.exports = {
    get activeClusterManager() {
        return global.activeClusterManager;
    },
    set activeClusterManager(manager) {
        global.activeClusterManager = manager;
        activeClusterManager = manager;
    }
}; 