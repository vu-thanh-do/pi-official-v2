const { cpus } = require('os');
const EventEmitter = require('events');

const { handleLike } = require('./like');
const { handlePiKnow } = require('./piKnow');

const { handleComment } = require('./comments');
const { handlePostArticles } = require('./posts');
const handleDelete = require('./delete');
const ExcelReaderService = require('../models/excelSheed');
const path = require('path');
const handleLogin = require('./login');
const handleLikeEachOther = require('./likeEachOther');

// Tạo event emitter để quản lý tiến độ
const progressEmitter = new EventEmitter();

// Biến để lưu trữ trạng thái hiện tại
let currentState = {
    isRunning: false,
    currentTask: null,
    progress: 0,
    error: null
};

// Hàm xử lý từng tác vụ
async function executeTask(task, config) {
    const { type, count } = task;
    const { userDelay, retryCount } = config;

    try {
        console.log(`\n>> Thực hiện tác vụ ${type} - Số lần: ${count}`);
        let result;

        switch (type) {
            case 'login':
                result = await handleLogin(count || 1);
                break;

            case 'likeEachOther':
                result = await handleLikeEachOther(count || 1);
                break;

            case 'like':
                result = await handleLike(count || 1);
                break;

            case 'piKnow':
                result = await handlePiKnow(count || 1);
                break;

            case 'comment':
                result = await handleComment(count || 1);
                break;

            case 'post':
                result = await handlePostArticles(count || 1);
                break;

            case 'delete':
                result = await handleDelete(count || 1);
                break;

            default:
                throw new Error(`Không hỗ trợ tác vụ: ${type}`);
        }
        console.log(result,'ccc')
        if (result.success) {
            console.log(`✅ Hoàn thành tác vụ ${type} - ${count} lần`);
        } else {
            console.log(`❌ Tác vụ ${type} thất bại sau ${count} lần thử`);
        }

        return result.success;
    } catch (error) {
        console.error(`Lỗi khi thực hiện tác vụ ${type}:`, error);
        return false;
    }
}

// Hàm xử lý luân phiên
async function handleRotation(config) {
    const { tasks, userDelay, retryCount } = config;

    try {
        let completedTasks = 0;
        const totalTasks = tasks.length;

        // Xử lý từng tác vụ theo thứ tự
        for (const task of tasks) {
            if (!currentState.isRunning) {
                console.log('>> Đã nhận lệnh dừng, dừng xử lý');
                break;
            }

            currentState.currentTask = task.type;
            console.log(`\n>> Thực hiện tác vụ: ${task.type}`);
            
            // Cập nhật tiến độ
            const progress = Math.floor((completedTasks / totalTasks) * 100);
            progressEmitter.emit('progress', {
                progress,
                currentTask: task.type,
                status: `Đang thực hiện tác vụ ${task.type}`,
                details: {
                    completedTasks,
                    totalTasks
                }
            });

            // Thực hiện tác vụ
            const success = await executeTask(task, { userDelay, retryCount });
            if (success) {
                completedTasks++;
                console.log(`✅ Hoàn thành tác vụ ${task.type}`);
            } else {
                console.log(`❌ Tác vụ ${task.type} thất bại`);
            }

            // Chờ giữa các tác vụ
            if (currentState.isRunning && task !== tasks[tasks.length - 1]) {
                console.log(`>> Chờ ${userDelay} giây trước khi thực hiện tác vụ tiếp theo...`);
                await new Promise(resolve => setTimeout(resolve, userDelay * 1000));
            }
        }

        // Cập nhật hoàn thành
        if (currentState.isRunning) {
            progressEmitter.emit('progress', {
                progress: 100,
                currentTask: 'Hoàn thành',
                status: 'Đã xử lý tất cả các tác vụ',
                details: {
                    completedTasks,
                    totalTasks
                }
            });
            console.log('\n>> Đã hoàn thành tất cả các tác vụ!');
        }

    } catch (error) {
        console.error('❌ Lỗi:', error.message);
        progressEmitter.emit('progress', {
            error: error.message
        });
    }
}

// Endpoint để bắt đầu luân phiên
async function startRotation(req, res) {
    try {
        const config = req.body;
        
        // Kiểm tra config
        if (!config || !config.tasks) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin cấu hình'
            });
        }

        // Nếu đang chạy thì dừng tiến trình cũ
        if (currentState.isRunning) {
            currentState.isRunning = false;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Khởi tạo trạng thái mới
        currentState = {
            isRunning: true,
            currentTask: null,
            progress: 0,
            error: null
        };

        console.log('\n>> Bắt đầu chế độ luân phiên');
        console.log('>> Cấu hình:', JSON.stringify(config, null, 2));

        // Bắt đầu xử lý luân phiên
        handleRotation(config);

        res.json({
            success: true,
            message: 'Đã bắt đầu tiến trình luân phiên'
        });

    } catch (error) {
        console.error('❌ Lỗi:', error.message);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
}

// Endpoint để dừng luân phiên
function stopRotation(req, res) {
    if (!currentState.isRunning) {
        return res.json({
            success: false,
            message: 'Không có tiến trình nào đang chạy'
        });
    }

    console.log('\n>> Đã nhận lệnh dừng tiến trình');
    currentState.isRunning = false;
    
    res.json({
        success: true,
        message: 'Đã gửi lệnh dừng tiến trình luân phiên'
    });
}

// Endpoint để theo dõi tiến độ
function rotationProgress(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Gửi heartbeat để giữ kết nối
    const heartbeat = setInterval(() => {
        res.write(':\n\n');
    }, 30000);

    // Xử lý sự kiện tiến độ
    const progressHandler = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    progressEmitter.on('progress', progressHandler);

    // Xử lý khi client ngắt kết nối
    req.on('close', () => {
        clearInterval(heartbeat);
        progressEmitter.removeListener('progress', progressHandler);
    });
}

module.exports = {
    startRotation,
    stopRotation,
    rotationProgress
}; 