const apiClient = require("../api/apiClient");
const qs = require("qs");
const path = require("path");
const {
  getAllPostIds,
  deletePostById,
} = require("../services/serviceGetPostUser");
const getAllPostPiKnow = require("../services/getAllPostPiKnow");
const ExcelReaderService = require("../models/excelSheed");
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
    this.piknowedPostIds = [];
    
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
            this.piknowedPostIds.push(result.postId);
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
      piknowedPostIds: this.piknowedPostIds,
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
    this.piknowedPostIds = [];
  }
}

function updateProgressStatus(queue) {
  const { total, completed, success, failure, running } = queue.stats;
  const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
  const bar = Array(20).fill('▒').map((char, i) => i < Math.floor(percent / 5) ? '█' : '▒').join('');
  
  console.log(`\n-------- TRẠNG THÁI TIẾN ĐỘ PIKNOW --------`);
  console.log(`[${bar}] ${percent}% (${completed}/${total})`);
  console.log(`✅ Thành công: ${success} | ❌ Thất bại: ${failure} | ⏳ Đang xử lý: ${running}`);
  console.log(`🧵 Luồng đang chạy: ${running} | 🔄 Tối đa luồng: ${queue.concurrencyLimit}`);
  console.log(`-----------------------------------------\n`);
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

function generateMixedPiKnowMessage(piknowMessages) {
  const wordPool = piknowMessages.reduce((acc, text) => {
    if (text) {
      acc.push(...splitIntoWords(text));
    }
    return acc;
  }, []);

  const phrasePool = piknowMessages.reduce((acc, text) => {
    if (text) {
      acc.push(...splitIntoPhrases(text));
    }
    return acc;
  }, []);

  const mixingStyle = Math.floor(Math.random() * 5);

  switch (mixingStyle) {
    case 0:
      return getRandomElement(piknowMessages);

    case 1:
      const numWords = Math.floor(Math.random() * 2) + 2;
      const words = [];
      for (let i = 0; i < numWords; i++) {
        words.push(getRandomElement(wordPool));
      }
      return words.join(' ');

    case 2:
      const phrase = getRandomElement(phrasePool);
      const word = getRandomElement(wordPool);
      return `${phrase} ${word}`;

    case 3:
      const phrases = [
        getRandomElement(phrasePool),
        getRandomElement(phrasePool)
      ];
      return phrases.join(', ');

    case 4:
      const firstWord = getRandomElement(wordPool);
      const middlePhrase = getRandomElement(phrasePool);
      const lastWord = getRandomElement(wordPool);
      return `${firstWord} ${middlePhrase} ${lastWord}`;
  }
}

async function handlePiKnow(req) {
  const taskQueue = new TaskQueue();
  try {
    const countPiKnow = req;
    console.log(`>> Yêu cầu piknow ${countPiKnow} bài viết`);
    if (countPiKnow <= 0) return { success: true, message: "Không cần piknow" };
    
    const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
    const excelReader = new ExcelReaderService(excelFilePath);
    const excelData = excelReader.readAllSheets();
    
    const uid = excelData["prxageng"]["uid"] || [];
    const piname = excelData["prxageng"]["piname"] || [];
    const proxy = excelData["prxageng"]["proxy"] || [];
    const ukey = excelData["prxageng"]["ukey"] || [];
    const userAgent = excelData["prxageng"]["user_agent"] || [];
    const piknow = excelData["piknow"]["piknow"] || [];

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

    console.log(`>> Bắt đầu lấy danh sách bài PiKnow cho từng user...`);
    
    const userPostsMap = new Map(); // Lưu trữ danh sách bài của từng user
    
    // Lấy danh sách bài cho từng user
    for (const user of userObjects) {
      const userPosts = await getAllPostPiKnow(user);
      if (userPosts.length > 0) {
        userPostsMap.set(user.uid, userPosts);
        console.log(`>> User ${user.piname} có ${userPosts.length} bài PiKnow`);
      } else {
        console.log(`>> User ${user.piname} không có bài PiKnow nào`);
      }
    }

    if (userPostsMap.size === 0) {
      return {
        success: false,
        message: "Không tìm thấy bài PiKnow nào cho tất cả users",
      };
    }

    console.log(`>> Tìm thấy ${userObjects.length} users, ${Array.from(userPostsMap.values()).reduce((sum, posts) => sum + posts.length, 0)} bài PiKnow`);
    console.log(`>> Bắt đầu piknow...`);

    const allTasks = [];
    const usedIds = new Map(); // Đổi thành Map để theo dõi riêng cho từng user

    for (const [userIndex, user] of userObjects.entries()) {
      console.log(`\n>> Chuẩn bị xử lý user ${userIndex + 1}/${userObjects.length}: ${user.piname}`);
      
      const userPosts = userPostsMap.get(user.uid) || [];
      if (userPosts.length === 0) {
        console.log(`>> Bỏ qua user ${user.piname} vì không có bài PiKnow`);
        continue;
      }

      if (!usedIds.has(user.uid)) {
        usedIds.set(user.uid, new Set());
      }
      const userUsedIds = usedIds.get(user.uid);

      for (let i = 0; i < countPiKnow; i++) {
        allTasks.push({
          userId: user.uid,
          task: async () => {
            console.log(`\n>> Bắt đầu piknow cho user ${user.piname} - Task ${i + 1}/${countPiKnow}`);
            
            const maxRetries = 2;
            let retryCount = 0;
            let selectedId;
            
            const urlVariants = ['/vapi', '/vapi/', 'vapi'];
            let currentUrlVariantIndex = 0;
            
            while (retryCount <= maxRetries) {
              try {
                if (retryCount > 0) {
                  console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho piknow của user ${user.piname}`);
                  await sleep(3000 * retryCount);
                }

                let availableIds = userPosts.filter(id => !userUsedIds.has(id));
                if (availableIds.length === 0) {
                  userUsedIds.clear();
                  availableIds = userPosts;
                }
                
                const randomIndex = Math.floor(Math.random() * availableIds.length);
                selectedId = availableIds[randomIndex];
                userUsedIds.add(selectedId);

                const randomMessage = generateMixedPiKnowMessage(piknow);
                console.log(`>> Nội dung piknow được tạo: "${randomMessage}"`);
                
                const api = apiClient(user);
                const payload = qs.stringify({
                  component: "know",
                  action: "answer",
                  message: randomMessage,
                  user_name: user.piname,
                  know_id: selectedId,
                  english_version: 0,
                  selected_country: 1,
                  selected_chain: 0,
                });
                
                const currentUrl = urlVariants[currentUrlVariantIndex];
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Piknow bài ID: ${selectedId} của user ${user.piname}`);
                const response = await api.post(currentUrl, payload);
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Status code: ${response.status}`);
                
                if (response.data && response.data.time) {
                  console.log(`✅ [Task ${userIndex+1}-${i+1}] Đã piknow thành công bài ID ${selectedId} của user ${user.piname}`);
                  return { success: true, postId: selectedId, userId: user.uid };
                } else {
                  console.log(`⚠️ [Task ${userIndex+1}-${i+1}] Piknow bài ID ${selectedId} không thành công:`, response.data);
                  return { success: false, postId: selectedId, userId: user.uid };
                }
              } catch (error) {
                console.error(`❌ [Task ${userIndex+1}-${i+1}] Lỗi khi piknow bài ID ${selectedId} của user ${user.piname}:`, error.message);
                
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
                        console.error(`❗️ [Task ${userIndex+1}-${i+1}] Lỗi 404: URL không tồn tại, kiểm tra lại endpoint`);
                        currentUrlVariantIndex = (currentUrlVariantIndex + 1) % urlVariants.length;
                        console.error(`❗️ [Task ${userIndex+1}-${i+1}] Sẽ thử với biến thể URL mới: ${urlVariants[currentUrlVariantIndex]}`);
                      }
                      
                      await sleep(delayTime);
                      continue;
                    }
                  }
                }
                
                return { success: false, postId: selectedId, userId: user.uid };
              }
            }
            
            return { success: false, postId: selectedId, userId: user.uid };
          }
        });
      }
    }

    if (allTasks.length === 0) {
      return {
        success: true,
        message: "Không có bài nào để piknow",
        stats: {
          total: 0,
          success: 0,
          failure: 0,
          piknowedPostIds: []
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

    console.log(`>> Tổng số ${allTasks.length} bài đã được thêm vào hàng đợi...`);
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

    const { success, failure, piknowedPostIds } = taskQueue.stats;
    console.log(`\n>> Kết quả cuối cùng: ${success} bài piknow thành công, ${failure} bài thất bại`);

    return { 
      success: success > 0,
      message: `Đã piknow ${success}/${success + failure} bài thành công!`,
      stats: {
        total: success + failure,
        success: success,
        failure: failure,
        piknowedPostIds: piknowedPostIds
      }
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi piknow: ${error.message}`,
      error: error.toString()
    };
  } finally {
    taskQueue.destroy();
  }
}

module.exports = handlePiKnow;
module.exports.handlePiKnow = handlePiKnow;