const ExcelReaderService = require("../models/excelSheed");
const apiClient = require("../api/apiClient");
const path = require("path");
const qs = require("qs");
const { getAllPostIds, deletePostById } = require("../services/serviceGetPostUser");
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
    this.deletedPostIds = [];
    
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
          if (result.postId) {
            this.deletedPostIds.push(result.postId);
          }
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
      deletedPostIds: this.deletedPostIds,
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
  }
}

function updateProgressStatus(queue) {
  const { total, completed, success, failure, running } = queue.stats;
  const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
  const bar = Array(20).fill('▒').map((char, i) => i < Math.floor(percent / 5) ? '█' : '▒').join('');
  
  console.log(`\n-------- TRẠNG THÁI TIẾN ĐỘ XÓA BÀI --------`);
  console.log(`[${bar}] ${percent}% (${completed}/${total})`);
  console.log(`✅ Thành công: ${success} | ❌ Thất bại: ${failure} | ⏳ Đang xử lý: ${running}`);
  console.log(`🧵 Luồng đang chạy: ${running} | 🔄 Tối đa luồng: ${queue.concurrencyLimit}`);
  console.log(`------------------------------------------\n`);
}

async function handleDelete(req) {
  const taskQueue = new TaskQueue();
  try {
    const deleteCount = req;
    console.log(`>> Yêu cầu xóa ${deleteCount} bài viết cho mỗi user`);

    if (deleteCount <= 0) return { success: true, message: "Không cần xóa bài" };
    
    const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
    const excelReader = new ExcelReaderService(excelFilePath);
    const excelData = excelReader.readAllSheets();
    
    const uid = excelData["prxageng"]["uid"] || [];
    const piname = excelData["prxageng"]["piname"] || [];
    const proxy = excelData["prxageng"]["proxy"] || [];
    const ukey = excelData["prxageng"]["ukey"] || [];
    const userAgent = excelData["prxageng"]["user_agent"] || [];

    const userObjects = uid.filter(user => user !== null).map((user, index) => {
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
    
    const concurrencyLimit = Math.min(process.env.MAX_CONCURRENCY || 100, userObjects.length * 5);
    console.log(`>> Đặt giới hạn luồng: ${concurrencyLimit}`);
    
    console.log(`>> Tìm thấy ${userObjects.length} users`);
    console.log(`>> Bắt đầu quá trình xóa bài...`);
    
    const userPostsMap = new Map();
    
    // Lấy danh sách bài viết của tất cả users
    for (const [userIndex, user] of userObjects.entries()) {
      console.log(`\n>> Đang lấy danh sách bài viết của user ${userIndex + 1}/${userObjects.length}: ${user.piname}`);
      
      try {
        const userPosts = await getAllPostIds(user);
        if (userPosts.length > 0) {
          userPostsMap.set(user.uid, userPosts);
          console.log(`>> Tìm thấy ${userPosts.length} bài viết của user ${user.piname}`);
        } else {
          console.log(`>> User ${user.piname} không có bài viết nào để xóa`);
        }
      } catch (error) {
        console.error(`❌ Lỗi khi lấy danh sách bài viết của user ${user.piname}:`, error.message);
      }
      
      await sleep(500);
    }

    const allTasks = [];
    
    // Tạo tasks xóa bài cho mỗi user
    for (const [userIndex, user] of userObjects.entries()) {
      const userPosts = userPostsMap.get(user.uid) || [];
      if (userPosts.length === 0) continue;
      
      const postsToDelete = Math.min(deleteCount, userPosts.length);
      console.log(`\n>> Chuẩn bị xóa ${postsToDelete} bài viết của user ${user.piname}`);
      
      const api = apiClient(user);
      
      for (let i = 0; i < postsToDelete; i++) {
        const postId = userPosts[i];
        allTasks.push({
          userId: user.uid,
          task: async () => {
            console.log(`\n>> Bắt đầu xóa bài viết ID ${postId} của user ${user.piname} - Task ${i + 1}/${postsToDelete}`);
            
            const maxRetries = 2;
            let retryCount = 0;
            
            const urlVariants = ['/vapi', '/vapi/', 'vapi'];
            let currentUrlVariantIndex = 0;
            
            while (retryCount <= maxRetries) {
              try {
                if (retryCount > 0) {
                  console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho xóa bài viết ID ${postId} của user ${user.piname}`);
                  await sleep(3000 * retryCount);
                }
                
                const payload = qs.stringify({
                  component: "article",
                  action: "delete",
                  uid: user.uid,
                  aid: postId,
                  user_name: user.piname,
                  english_version: 0,
                  selected_country: 1,
                  selected_chain: 0,
                });
                
                const currentUrl = urlVariants[currentUrlVariantIndex];
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Xóa bài viết ID: ${postId} của user ${user.piname}`);
                const response = await api.post(currentUrl, payload);
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Status code: ${response.status}`);
                
                if (response.data && response.data.hasOwnProperty('data') && response.data.data && response.data.data.status === 1) {
                  console.log(`✅ [Task ${userIndex+1}-${i+1}] Đã xóa thành công bài viết ID ${postId} của user ${user.piname}`);
                  return { success: true, postId };
                } else {
                  console.log(`⚠️ [Task ${userIndex+1}-${i+1}] Xóa bài viết ID ${postId} không thành công:`, response.data);
                  
                  if (response.data && response.data.message && (
                      response.data.message.includes("không tồn tại") || 
                      response.data.message.includes("not exist") ||
                      response.data.message.includes("đã xóa")
                  )) {
                    console.log(`ℹ️ [Task ${userIndex+1}-${i+1}] Bài viết ID ${postId} có thể đã bị xóa trước đó hoặc không tồn tại`);
                    return { success: true, postId, alreadyDeleted: true };
                  }
                  
                  return { success: false, postId };
                }
              } catch (error) {
                console.error(`❌ [Task ${userIndex+1}-${i+1}] Lỗi khi xóa bài viết ID ${postId} của user ${user.piname}:`, error.message);
                
                if (error.response) {
                  console.error(`Mã lỗi: ${error.response.status}`);
                  console.error(`URL gọi: ${error.config?.url}`);
                  console.error(`URL đầy đủ: ${error.config?.baseURL}${error.config?.url}`);
                  console.error(`Phương thức: ${error.config?.method.toUpperCase()}`);
                  
                  if ([404, 429, 500, 502, 503, 504].includes(error.response.status)) {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                      const delayTime = error.response.status === 429 ? 10000 : 3000 * retryCount;
                      console.log(`>> [Task ${userIndex+1}-${i+1}] Sẽ thử lại sau ${delayTime/1000} giây...`);
                      
                      if (error.response.status === 404) {
                        currentUrlVariantIndex = (currentUrlVariantIndex + 1) % urlVariants.length;
                        console.error(`❗️ [Task ${userIndex+1}-${i+1}] Sẽ thử với biến thể URL mới: ${urlVariants[currentUrlVariantIndex]}`);
                      }
                      
                      await sleep(delayTime);
                      continue;
                    }
                  }
                }
                
                return { success: false, postId };
              }
            }
            
            return { success: false, postId };
          }
        });
      }
    }

    if (allTasks.length === 0) {
      return {
        success: true,
        message: "Không có bài viết nào để xóa",
        stats: {
          total: 0,
          success: 0,
          failure: 0,
          deletedPostIds: []
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

    console.log(`>> Tổng số ${allTasks.length} bài viết đã được thêm vào hàng đợi...`);
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

    const { success, failure, deletedPostIds } = taskQueue.stats;
    console.log(`\n>> Kết quả cuối cùng: ${success} bài viết xóa thành công, ${failure} bài viết thất bại`);

    return { 
      success: success > 0,
      message: `Đã xóa ${success}/${success + failure} bài viết thành công!`,
      stats: {
        total: success + failure,
        success: success,
        failure: failure,
        deletedPostIds: deletedPostIds
      }
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi xóa bài: ${error.message}`,
      error: error.toString()
    };
  } finally {
    taskQueue.destroy();
  }
}

module.exports = handleDelete;
module.exports.handleDelete = handleDelete;