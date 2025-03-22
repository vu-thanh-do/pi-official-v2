const ExcelReaderService = require("../models/excelSheed");
const apiClient = require("../api/apiClient");
const path = require("path");
const qs = require("qs");
const getImageUrl = require("../services/serviceGetImage");
const { cpus } = require('os');
const cluster = require('cluster');
const ClusterManager = require('./cluster-manager');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class TaskQueue {
  constructor(concurrencyLimit = 10000) {
    this.concurrencyLimit = concurrencyLimit;
    this.runningTasks = 0;
    this.queue = [];
    this.results = [];
    this.completedCount = 0;
    this.successCount = 0;
    this.failCount = 0;
    this.totalTasks = 0;
    this.userLastRequestTime = new Map();
    this.isProcessing = false;
    this.processInterval = null;
    this.gcInterval = null; // Interval để dọn dẹp bộ nhớ
    
    // Khởi tạo interval để xử lý queue
    this.startProcessing();
    
    // Khởi tạo garbage collector interval
    this.startGarbageCollection();
  }

  startProcessing() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
    }
    // Thay vì đệ quy, sử dụng setInterval để kiểm tra và xử lý queue định kỳ
    this.processInterval = setInterval(() => {
      if (!this.isProcessing) {
        this.processQueue();
      }
    }, 100); // Kiểm tra mỗi 100ms
  }

  startGarbageCollection() {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }
    // Định kỳ dọn dẹp bộ nhớ
    this.gcInterval = setInterval(() => {
      this.cleanupMemory();
    }, 300000); // 5 phút dọn dẹp một lần
  }

  cleanupMemory() {
    // Dọn dẹp kết quả cũ
    if (this.results.length > 1000) {
      this.results = this.results.slice(-1000);
    }
    
    // Dọn dẹp thời gian request của các user không còn hoạt động
    const now = Date.now();
    for (const [userId, lastTime] of this.userLastRequestTime.entries()) {
      if (now - lastTime > 3600000) { // 1 giờ
        this.userLastRequestTime.delete(userId);
      }
    }
  }

  async add(taskFn, userId) {
    return new Promise((resolve) => {
      this.queue.push({ taskFn, resolve, userId, addedTime: Date.now() });
      this.totalTasks++;
    });
  }

  async processQueue() {
    if (this.queue.length === 0 || this.runningTasks >= this.concurrencyLimit) {
      return;
    }

    this.isProcessing = true;
    
    try {
      const now = Date.now();
      
      // Tìm các task có thể chạy (thỏa mãn điều kiện delay)
      const eligibleTasks = this.queue.filter(task => {
        const lastRequestTime = this.userLastRequestTime.get(task.userId) || 0;
        return (now - lastRequestTime) >= 2000;
      });

      if (eligibleTasks.length === 0) {
        return;
      }

      // Sắp xếp theo thời gian chờ
      eligibleTasks.sort((a, b) => a.addedTime - b.addedTime);

      // Lấy task đầu tiên
      const taskIndex = this.queue.findIndex(t => t === eligibleTasks[0]);
      const { taskFn, resolve, userId } = this.queue.splice(taskIndex, 1)[0];

      this.runningTasks++;
      this.userLastRequestTime.set(userId, now);

      try {
        const result = await taskFn();
        this.completedCount++;
        if (result.success) {
          this.successCount++;
        } else {
          this.failCount++;
        }
        this.results.push({ status: 'fulfilled', value: result });
        resolve(result);
      } catch (error) {
        this.completedCount++;
        this.failCount++;
        this.results.push({ status: 'rejected', reason: error.message });
        resolve({ success: false, error: error.message });
      }
    } finally {
      this.runningTasks--;
      this.isProcessing = false;
    }
  }

  get stats() {
    return {
      total: this.totalTasks,
      completed: this.completedCount,
      success: this.successCount,
      failure: this.failCount,
      pending: this.totalTasks - this.completedCount,
      running: this.runningTasks,
      queued: this.queue.length,
      memoryUsage: process.memoryUsage()
    };
  }

  destroy() {
    // Dọn dẹp các interval khi không cần thiết nữa
    if (this.processInterval) {
      clearInterval(this.processInterval);
    }
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }
    // Xóa các tham chiếu
    this.queue = [];
    this.results = [];
    this.userLastRequestTime.clear();
  }
}

function updateProgressStatus(queue) {
  const { total, completed, success, failure, running } = queue.stats;
  const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
  const bar = Array(20).fill('▒').map((char, i) => i < Math.floor(percent / 5) ? '█' : '▒').join('');
  
  console.log(`\n-------- TRẠNG THÁI TIẾN ĐỘ ĐĂNG BÀI --------`);
  console.log(`[${bar}] ${percent}% (${completed}/${total})`);
  console.log(`✅ Thành công: ${success} | ❌ Thất bại: ${failure} | ⏳ Đang xử lý: ${running}`);
  console.log(`🧵 Luồng đang chạy: ${running} | 🔄 Tối đa luồng: ${queue.concurrencyLimit}`);
  console.log(`------------------------------------------\n`);
}

function splitIntoWords(text) {
  return text.split(/\s+/).filter(word => word.length > 0);
}

function splitIntoPhrases(text) {
  return text.split(/[,.!?;]/)
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.length > 0);
}

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function generateMixedContent(sourceTexts, minParts = 2, maxParts = 4) {
  const wordPool = sourceTexts.reduce((acc, text) => {
    if (text) {
      acc.push(...splitIntoWords(text));
    }
    return acc;
  }, []);

  const phrasePool = sourceTexts.reduce((acc, text) => {
    if (text) {
      acc.push(...splitIntoPhrases(text));
    }
    return acc;
  }, []);

  const mixingStyle = Math.floor(Math.random() * 4);
  const parts = [];
  const numParts = Math.floor(Math.random() * (maxParts - minParts + 1)) + minParts;

  switch (mixingStyle) {
    case 0: 
      for (let i = 0; i < numParts; i++) {
        parts.push(getRandomElement(phrasePool));
      }
      return parts.join(', ');

    case 1: 
      for (let i = 0; i < numParts + 2; i++) {
        parts.push(getRandomElement(wordPool));
      }
      return parts.join(' ');

    case 2: 
      for (let i = 0; i < numParts; i++) {
        if (Math.random() > 0.5) {
          parts.push(getRandomElement(phrasePool));
        } else {
          const numWords = Math.floor(Math.random() * 3) + 1;
          const words = [];
          for (let j = 0; j < numWords; j++) {
            words.push(getRandomElement(wordPool));
          }
          parts.push(words.join(' '));
        }
      }
      return parts.join(', ');

    case 3: 
      const mainPhrase = getRandomElement(phrasePool);
      const words = [];
      for (let i = 0; i < 2; i++) {
        words.push(getRandomElement(wordPool));
      }
      return `${mainPhrase} ${words.join(' ')}`;
  }
}

function generateUniqueTitle(titles) {
  const title = generateMixedContent(titles, 2, 3);
  return `${title}`;
}

function generateUniqueContent(contents) {
  return generateMixedContent(contents, 3, 5);
}

// Cập nhật hàm handlePostArticles để sử dụng cluster
async function handlePostArticles(req) {
  try {
    const postCount = req;
    console.log(`>> Yêu cầu đăng ${postCount} bài viết`);

    if (postCount <= 0) return { success: true, message: "Không cần đăng bài" };
    
    // Kiểm tra xem hiện tại đang ở Master hay Worker
    if (cluster.isPrimary) {
      // Khởi tạo quản lý cluster
      const availableCores = cpus().length;
      console.log(`>> Máy tính có ${availableCores} CPU cores`);
      
      // Tính toán số lượng worker tối ưu - nên để lại ít nhất 1 core cho hệ thống
      const workerCount = Math.max(1, availableCores - 1);
      console.log(`>> Khởi tạo ${workerCount} worker processes...`);
      
      // Khởi tạo cluster manager
      const clusterManager = new ClusterManager({ numWorkers: workerCount });
      
      // Sự kiện hoàn thành
      clusterManager.on('complete', (results) => {
        console.log(`\n>> Kết quả cuối cùng: ${results.success} bài viết đăng thành công, ${results.failure} bài viết thất bại`);
      });
      
      // Khởi tạo cluster
      const isMaster = await clusterManager.initialize();
      
      if (isMaster) {
        // Phân phối tài khoản cho các worker
        await clusterManager.distributeAccounts(postCount);
        
        // Đợi tất cả worker hoàn thành
        return new Promise((resolve) => {
          clusterManager.on('complete', (results) => {
            resolve({
              success: true,
              message: `Đã đăng ${results.success}/${results.total} bài viết thành công!`,
              stats: {
                total: results.total,
                success: results.success,
                failure: results.failure,
              }
            });
          });
          
          // Thêm timeout để tránh việc chờ vô hạn
          setTimeout(() => {
            resolve({
              success: true,
              message: `Đã quá thời gian chờ. Đã đăng ${clusterManager.results.success}/${clusterManager.results.total} bài viết.`,
              stats: { ...clusterManager.results }
            });
          }, 1000 * 60 * 30); // 30 phút timeout
        });
      }
    }
    
    // Nếu đang ở worker process, không làm gì cả vì worker sẽ được quản lý bởi worker-processor.js
    return { 
      success: true,
      message: "Đã khởi động các worker processes để đăng bài"
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi đăng bài: ${error.message}`,
      error: error.toString()
    };
  }
}

module.exports = { handlePostArticles };
