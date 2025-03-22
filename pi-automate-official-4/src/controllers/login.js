const path = require('path');
const ExcelReaderService = require('../models/excelSheed');
const apiClient = require('../api/apiClient');
const qs = require("qs");
const { cpus } = require('os');

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
    this.gcInterval = null;
    this.loginResults = new Map();
    
    this.startProcessing();
    this.startGarbageCollection();
  }

  startProcessing() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
    }
    this.processInterval = setInterval(() => {
      if (!this.isProcessing) {
        this.processQueue();
      }
    }, 100);
  }

  startGarbageCollection() {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }
    this.gcInterval = setInterval(() => {
      this.cleanupMemory();
    }, 300000);
  }

  cleanupMemory() {
    if (this.results.length > 1000) {
      this.results = this.results.slice(-1000);
    }
    
    const now = Date.now();
    for (const [userId, lastTime] of this.userLastRequestTime.entries()) {
      if (now - lastTime > 3600000) {
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
      
      const eligibleTasks = this.queue.filter(task => {
        const lastRequestTime = this.userLastRequestTime.get(task.userId) || 0;
        return (now - lastRequestTime) >= 2000;
      });

      if (eligibleTasks.length === 0) {
        return;
      }

      eligibleTasks.sort((a, b) => a.addedTime - b.addedTime);

      const taskIndex = this.queue.findIndex(t => t === eligibleTasks[0]);
      const { taskFn, resolve, userId } = this.queue.splice(taskIndex, 1)[0];

      this.runningTasks++;
      this.userLastRequestTime.set(userId, now);

      try {
        const result = await taskFn();
        this.completedCount++;
        if (result.success) {
          this.successCount++;
          this.loginResults.set(result.userId, {
            piname: result.piname,
            status: 'success'
          });
        } else {
          this.failCount++;
          this.loginResults.set(result.userId, {
            piname: result.piname,
            status: 'failed'
          });
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
      loginResults: Object.fromEntries(this.loginResults),
      memoryUsage: process.memoryUsage()
    };
  }

  destroy() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
    }
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }
    this.queue = [];
    this.results = [];
    this.userLastRequestTime.clear();
    this.loginResults.clear();
  }
}

function updateProgressStatus(queue) {
  const { total, completed, success, failure, running } = queue.stats;
  const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
  const bar = Array(20).fill('▒').map((char, i) => i < Math.floor(percent / 5) ? '█' : '▒').join('');
  
  console.log(`\n-------- TRẠNG THÁI TIẾN ĐỘ ĐĂNG NHẬP --------`);
  console.log(`[${bar}] ${percent}% (${completed}/${total})`);
  console.log(`✅ Thành công: ${success} | ❌ Thất bại: ${failure} | ⏳ Đang xử lý: ${running}`);
  console.log(`🧵 Luồng đang chạy: ${running} | 🔄 Tối đa luồng: ${queue.concurrencyLimit}`);
  console.log(`-----------------------------------------\n`);
}

async function handleLogin(req) {
  const taskQueue = new TaskQueue();
  try {
    const countLogin = req;
    console.log(`>> Yêu cầu đăng nhập ${countLogin} tài khoản`);
    if (countLogin <= 0) return { success: true, message: "Không cần đăng nhập" };
    
    const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
    const excelReader = new ExcelReaderService(excelFilePath);
    const excelData = excelReader.readAllSheets();
    
    const uid = excelData["prxageng"]["uid"] || [];
    const piname = excelData["prxageng"]["piname"] || [];
    const proxy = excelData["prxageng"]["proxy"] || [];
    const ukey = excelData["prxageng"]["ukey"] || [];
    const userAgent = excelData["prxageng"]["user_agent"] || [];

    const userObjects = uid.map((user, index) => {
      const newProxy = proxy[index].split(":");
      return {
        uid: user,
        piname: piname[index],
        ukey: ukey[index],
        userAgent: userAgent[index],
        proxy: {
          host: newProxy[0],
          port: newProxy[1],
          name: newProxy[2],
          password: newProxy[3],
        },
      };
    });

    if (userObjects.length === 0) {
      return {
        success: false,
        message: "Không tìm thấy dữ liệu user từ file Excel",
      };
    }

    const totalCores = cpus().length;
    console.log(`>> Máy tính có ${totalCores} CPU cores`);
    
    const concurrencyLimit = Math.min(process.env.MAX_CONCURRENCY || 100, userObjects.length * 2);
    console.log(`>> Đặt giới hạn luồng: ${concurrencyLimit}`);

    console.log(`>> Tìm thấy ${userObjects.length} tài khoản`);
    
    const allTasks = [];
    const usersToLogin = userObjects;

    for (const [userIndex, user] of usersToLogin.entries()) {
      allTasks.push({
        userId: user.uid,
        task: async () => {
          console.log(`\n>> Đang đăng nhập tài khoản ${userIndex + 1}/${countLogin}: ${user.piname}`);
          
          const maxRetries = 2;
          let retryCount = 0;
          
          while (retryCount <= maxRetries) {
            try {
              if (retryCount > 0) {
                console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho tài khoản ${user.piname}`);
                await sleep(3000 * retryCount);
              }

              const api = apiClient(user);
              const payload = qs.stringify({
                component: "signin",
                action: "go",
                user_name: user.piname,
                english_version: 0,
                selected_country: 1,
                selected_chain: 0
              });

              const response = await api.post('/api', payload);
              
              if (response.data && response.data.status && response.data.task) {
                console.log(`✅ Đăng nhập thành công tài khoản ${user.piname}`);
                return { success: true, userId: user.uid, piname: user.piname };
              } else {
                console.log(`⚠️ Đăng nhập không thành công tài khoản ${user.piname}:`, response.data);
                return { success: false, userId: user.uid, piname: user.piname };
              }
            } catch (error) {
              console.error(`❌ Lỗi khi đăng nhập tài khoản ${user.piname}:`, error.message);
              
              if (error.response) {
                console.error(`Mã lỗi: ${error.response.status}`);
                console.error(`URL gọi: ${error.config?.url}`);
                console.error(`URL đầy đủ: ${error.config?.baseURL}${error.config?.url}`);
                console.error(`Phương thức: ${error.config?.method.toUpperCase()}`);
                
                if ([404, 429, 500, 502, 503, 504].includes(error.response.status)) {
                  retryCount++;
                  if (retryCount <= maxRetries) {
                    const delayTime = error.response.status === 429 ? 10000 : 3000 * retryCount;
                    console.log(`>> Sẽ thử lại sau ${delayTime/1000} giây...`);
                    await sleep(delayTime);
                    continue;
                  }
                }
              }
              
              return { success: false, userId: user.uid, piname: user.piname };
            }
          }
          
          return { success: false, userId: user.uid, piname: user.piname };
        }
      });
    }

    if (allTasks.length === 0) {
      return {
        success: true,
        message: "Không có tài khoản nào để đăng nhập",
        stats: {
          total: 0,
          success: 0,
          failure: 0,
          loginResults: {}
        }
      };
    }

    // Xáo trộn tasks để phân bố đều
    for (let i = allTasks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allTasks[i], allTasks[j]] = [allTasks[j], allTasks[i]];
    }

    // Thêm tasks vào queue
    for (const { userId, task } of allTasks) {
      await taskQueue.add(task, userId);
    }

    console.log(`>> Tổng số ${allTasks.length} tài khoản đã được thêm vào hàng đợi...`);
    console.log(`>> Đang chạy với tối đa ${concurrencyLimit} luồng đồng thời...`);

    const progressInterval = setInterval(() => {
      updateProgressStatus(taskQueue);
      const memUsage = process.memoryUsage();
      console.log(`\n-------- MEMORY USAGE --------`);
      console.log(`Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
      console.log(`Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
      console.log(`RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
      console.log(`-----------------------------\n`);
    }, 3000);

    while (taskQueue.stats.completed < taskQueue.stats.total) {
      await sleep(1000);
    }

    clearInterval(progressInterval);
    updateProgressStatus(taskQueue);

    const { success, failure, loginResults } = taskQueue.stats;
    console.log(`\n>> Kết quả cuối cùng: ${success} tài khoản đăng nhập thành công, ${failure} tài khoản thất bại`);

    return { 
      success: success > 0,
      message: `Đã đăng nhập ${success}/${success + failure} tài khoản thành công!`,
      stats: {
        total: success + failure,
        success: success,
        failure: failure,
        loginResults: loginResults
      }
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi đăng nhập: ${error.message}`,
      error: error.toString()
    };
  } finally {
    taskQueue.destroy();
  }
}

module.exports = handleLogin;
