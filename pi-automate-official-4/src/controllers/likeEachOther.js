const path = require('path');
const ExcelReaderService = require('../models/excelSheed');
const apiClient = require('../api/apiClient');
const qs = require("qs");
const getUserPosts = require("../services/getPostUser");
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
    this.likedPosts = new Map();
    
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
          if (result.targetUserId && result.postId) {
            if (!this.likedPosts.has(result.targetUserId)) {
              this.likedPosts.set(result.targetUserId, []);
            }
            this.likedPosts.get(result.targetUserId).push({
              postId: result.postId,
              likedBy: result.userId
            });
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
      likedPosts: Object.fromEntries(this.likedPosts),
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
    this.likedPosts.clear();
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
  console.log(`-----------------------------------------\n`);
}

function getRandomUsers(users, n) {
  const shuffled = [...users].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, n);
}

async function handleLikeEachOther(req) {
  const taskQueue = new TaskQueue();
  try {
    const countLikeEachOther = req;
    console.log(`>> Yêu cầu like ${countLikeEachOther} bài viết cho mỗi user`);
    if (countLikeEachOther <= 0) return { success: true, message: "Không cần like" };
    
    const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
    const excelReader = new ExcelReaderService(excelFilePath);
    const excelData = excelReader.readAllSheets();
    
    const uid = excelData["prxageng"]["uid"] || [];
    const piname = excelData["prxageng"]["piname"] || [];
    const proxy = excelData["prxageng"]["proxy"] || [];
    const ukey = excelData["prxageng"]["ukey"] || [];
    const userAgent = excelData["prxageng"]["user_agent"] || [];
    const listUserId = excelData["likeEachOther"]["profileId"] || [];

    if (listUserId.length === 0) {
      return {
        success: false,
        message: "Không tìm thấy danh sách user cần like",
      };
    }

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
    
    console.log(`>> Tìm thấy ${userObjects.length} users để like, ${listUserId.length} users cần được like`);
    
    const allTasks = [];
    const usedUsersForPost = new Map();

    for (const [targetUserIndex, targetUserId] of listUserId.entries()) {
      console.log(`\n>> Đang xử lý user ${targetUserIndex + 1}/${listUserId.length}: ${targetUserId}`);
      
      const targetUser = {
        uid: targetUserId,
        piname: targetUserId,
        ukey: "",
        userAgent: userObjects[0].userAgent,
        proxy: userObjects[0].proxy
      };
      
      const userPosts = await getUserPosts(targetUser);
      console.log(`>> Tìm thấy ${userPosts.length} bài viết của user ${targetUserId}`);

      const postsToLike = userPosts.slice(0, countLikeEachOther);
      console.log(`>> Sẽ like ${postsToLike.length} bài viết gần nhất`);

      for (const [postIndex, postId] of postsToLike.entries()) {
        const availableUsers = userObjects.filter(u => 
          !usedUsersForPost.get(postId)?.includes(u.uid)
        );

        if (availableUsers.length < 12) {
          console.log(`⚠️ Không đủ user để like bài ${postId} (cần 12, có ${availableUsers.length})`);
          continue;
        }

        const selectedUsers = getRandomUsers(availableUsers, 12);
        usedUsersForPost.set(postId, selectedUsers.map(u => u.uid));

        for (const [likeUserIndex, likeUser] of selectedUsers.entries()) {
          allTasks.push({
            userId: likeUser.uid,
            task: async () => {
              console.log(`\n>> Bắt đầu like bài ${postId} của user ${targetUserId} bởi ${likeUser.piname}`);
              
              const maxRetries = 2;
              let retryCount = 0;
              
              while (retryCount <= maxRetries) {
                try {
                  if (retryCount > 0) {
                    console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho like bài ${postId}`);
                    await sleep(3000 * retryCount);
                  }

                  const api = apiClient(likeUser);
                  const payload = qs.stringify({
                    component: "article",
                    action: "like",
                    aid: postId,
                    user_name: likeUser.piname,
                    english_version: 0,
                    selected_country: 1,
                    selected_chain: 0,
                  });

                  const response = await api.post('/vapi', payload);
                  
                  if (response.data && response.data.time) {
                    console.log(`✅ Đã like thành công bài ${postId} bởi ${likeUser.piname}`);
                    return { success: true, postId, userId: likeUser.uid, targetUserId };
                  } else {
                    console.log(`⚠️ Like bài ${postId} không thành công:`, response.data);
                    return { success: false, postId, userId: likeUser.uid, targetUserId };
                  }
                } catch (error) {
                  console.error(`❌ Lỗi khi like bài ${postId} bởi ${likeUser.piname}:`, error.message);
                  
                  if (error.response) {
                    console.error(`Mã lỗi: ${error.response.status}`);
                    console.error(`URL gọi: ${error.config?.url}`);
                    console.error(`URL đầy đủ: ${error.config?.baseURL}${error.config?.url}`);
                    console.error(`Phương thức: ${error.config?.method.toUpperCase()}`);
                    
                    if ([404, 429, 500, 502, 503, 504].includes(error.response.status)) {
                      retryCount++;
                      if (retryCount <= maxRetries) {
                        const delayTime = error.response.status === 429 ? 10000 : 3000 * retryCount;
                        console.log(`>> [Task] Sẽ thử lại sau ${delayTime/1000} giây...`);
                        await sleep(delayTime);
                        continue;
                      }
                    }
                  }
                  
                  return { success: false, postId, userId: likeUser.uid, targetUserId };
                }
              }
              
              return { success: false, postId, userId: likeUser.uid, targetUserId };
            }
          });
        }
      }
    }

    if (allTasks.length === 0) {
      return {
        success: true,
        message: "Không có bài nào để like",
        stats: {
          total: 0,
          success: 0,
          failure: 0,
          likedPosts: {}
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

    console.log(`>> Tổng số ${allTasks.length} lượt like đã được thêm vào hàng đợi...`);
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

    const { success, failure, likedPosts } = taskQueue.stats;
    console.log(`\n>> Kết quả cuối cùng: ${success} lượt like thành công, ${failure} lượt thất bại`);

    return { 
      success: success > 0,
      message: `Đã like ${success}/${success + failure} lượt thành công!`,
      stats: {
        total: success + failure,
        success: success,
        failure: failure,
        likedPosts: likedPosts
      }
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi likeEachOther: ${error.message}`,
      error: error.toString()
    };
  } finally {
    taskQueue.destroy();
  }
}

module.exports = handleLikeEachOther;
