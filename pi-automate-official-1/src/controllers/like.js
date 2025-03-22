const ExcelReaderService = require("../models/excelSheed");
const apiClient = require("../api/apiClient");
const getArticleId = require("../services/getArticleId");
const path = require("path");
const qs = require('qs');
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
    this.uniqueArticlesLiked = new Set();
    
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
          if (result.articleId) {
            this.uniqueArticlesLiked.add(result.articleId);
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
      uniqueArticles: this.uniqueArticlesLiked.size,
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
  
  console.log(`\n-------- TRẠNG THÁI TIẾN ĐỘ LIKE --------`);
  console.log(`[${bar}] ${percent}% (${completed}/${total})`);
  console.log(`✅ Thành công: ${success} | ❌ Thất bại: ${failure} | ⏳ Đang xử lý: ${running}`);
  console.log(`🧵 Luồng đang chạy: ${running} | 🔄 Tối đa luồng: ${queue.concurrencyLimit}`);
  console.log(`----------------------------------------\n`);
}

async function handleLike(req) {
  const taskQueue = new TaskQueue();
  try {
    const likeCount = req;
    console.log(`>> Yêu cầu thực hiện ${likeCount} like`);

    if (likeCount <= 0) return { success: true, message: "Không cần like" };
    
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
    
    console.log(`>> Đang tải danh sách bài viết để like...`);
    const articleIds = new Set(); 
    
    const requiredCount = likeCount * 2;
    let retries = 0;
    
    while (articleIds.size < requiredCount && retries < 10) {
      try {
        const newId = await getArticleId();
        if (newId) {
          articleIds.add(newId);
          console.log(`>> Đã lấy bài viết #${articleIds.size}: ID ${newId}`);
        }
      } catch (error) {
        console.log(`❌ Lỗi khi lấy article ID: ${error.message}`);
      }
      
      await sleep(300);
      
      if (articleIds.size < Math.min(retries + 1, requiredCount)) {
        retries++;
      }
    }
    
    const availableArticleIds = Array.from(articleIds);
    
    if (availableArticleIds.length === 0) {
      console.log(`❌ Không thể lấy được bài viết nào để like. Sử dụng ID mặc định.`);
      availableArticleIds.push(58203589); 
    }
    
    console.log(`>> Đã chuẩn bị ${availableArticleIds.length} bài viết khác nhau để like`);
    console.log(`>> Bắt đầu thực hiện like...`);
    
    const allTasks = [];
    const userLikedArticles = new Map();
    
    for (const [userIndex, user] of userObjects.entries()) {
      console.log(`\n>> Chuẩn bị xử lý user ${userIndex + 1}/${userObjects.length}: ${user.piname}`);
      
      const api = apiClient(user);
      userLikedArticles.set(user.uid, new Set());
      
      for (let i = 0; i < likeCount; i++) {
        allTasks.push({
          userId: user.uid,
          task: async () => {
            console.log(`\n>> Bắt đầu like với user ${user.piname} - Task ${i + 1}/${likeCount}`);
            
            let articleId;
            let attempts = 0;
            const maxAttempts = 5;
            const userLiked = userLikedArticles.get(user.uid);
            
            while (attempts < maxAttempts) {
              const randomIndex = Math.floor(Math.random() * availableArticleIds.length);
              const candidateId = availableArticleIds[randomIndex];
              
              if (!userLiked.has(candidateId)) {
                articleId = candidateId;
                userLiked.add(articleId);
                console.log(`>> Đã chọn bài viết ID ${articleId} cho user ${user.piname}`);
                break;
              }
              
              attempts++;
              
              if (attempts === maxAttempts - 1) {
                try {
                  const newId = await getArticleId();
                  if (newId && !userLiked.has(newId)) {
                    articleId = newId;
                    availableArticleIds.push(newId);
                    userLiked.add(articleId);
                    console.log(`>> Lấy thêm bài viết mới ID ${articleId} cho user ${user.piname}`);
                    break;
                  }
                } catch (error) {
                  console.log(`❌ Lỗi khi lấy article ID mới: ${error.message}`);
                }
              }
            }
            
            if (!articleId) {
              articleId = 58203589;
              console.log(`❌ Không tìm được bài viết chưa like, sử dụng ID mặc định: ${articleId}`);
            }
            
            const maxRetries = 2;
            let retryCount = 0;
            
            const urlVariants = ['/vapi', '/vapi/', 'vapi'];
            let currentUrlVariantIndex = 0;
            
            while (retryCount <= maxRetries) {
              try {
                if (retryCount > 0) {
                  console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho like với user ${user.piname}`);
                  await sleep(3000 * retryCount);
                }
                
                const payload = qs.stringify({
                  component: "article",
                  action: "like",
                  aid: articleId,
                  user_name: user.piname,
                  english_version: 0,
                  selected_country: 1,
                  selected_chain: 0,
                });
                
                const currentUrl = urlVariants[currentUrlVariantIndex];
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Like bài viết ID: ${articleId} với user ${user.piname}`);
                const response = await api.post(currentUrl, payload);
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Status code: ${response.status}`);
                
                if (response.data && response.data.hasOwnProperty('data')) {
                  console.log(`✅ [Task ${userIndex+1}-${i+1}] User ${user.piname} đã like bài viết ${articleId} thành công!`);
                  return { success: true, articleId };
                } else {
                  console.log(`⚠️ [Task ${userIndex+1}-${i+1}] User ${user.piname} like bài viết ${articleId} không thành công:`, response.data);
                  
                  if (response.data && response.data.message && (
                      response.data.message.includes("đã like") || 
                      response.data.message.includes("already") ||
                      response.data.message.includes("Đã like")
                  )) {
                    console.log(`ℹ️ [Task ${userIndex+1}-${i+1}] Bài viết ${articleId} đã được like trước đó bởi user ${user.piname}`);
                  }
                  
                  return { success: false, articleId };
                }
              } catch (error) {
                console.error(`❌ [Task ${userIndex+1}-${i+1}] Lỗi khi like bài viết ${articleId} với user ${user.piname}:`, error.message);
                
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
                
                return { success: false, articleId };
              }
            }
            
            return { success: false, articleId };
          }
        });
      }
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

    console.log(`>> Tổng số ${allTasks.length} like đã được thêm vào hàng đợi...`);
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

    const { success, failure, uniqueArticles } = taskQueue.stats;
    console.log(`\n>> Kết quả cuối cùng: ${success} like thành công, ${failure} like thất bại`);
    console.log(`>> Tổng số bài viết độc nhất đã like: ${uniqueArticles}`);

    return { 
      success: success > 0,
      message: `Đã thực hiện ${success}/${success + failure} like thành công!`,
      stats: {
        total: success + failure,
        success: success,
        failure: failure,
        uniqueArticles: uniqueArticles
      }
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi thực hiện like: ${error.message}`,
      error: error.toString()
    };
  } finally {
    taskQueue.destroy();
  }
}

module.exports = { handleLike };
