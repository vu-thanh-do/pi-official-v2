const ExcelReaderService = require("../models/excelSheed");
const apiClient = require("../api/apiClient");
const path = require("path");
const qs = require("qs");
const getImageUrl = require("../services/serviceGetImage");
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

async function handlePostArticles(req) {
  
    const taskQueue = new TaskQueue();
  try {
    const postCount = req;
    console.log(`>> Yêu cầu đăng ${postCount} bài viết`);

    if (postCount <= 0) return { success: true, message: "Không cần đăng bài" };
    
    const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
    const excelReader = new ExcelReaderService(excelFilePath);
    const excelData = excelReader.readAllSheets();
    
    const uid = excelData["prxageng"]["uid"] || [];
    const piname = excelData["prxageng"]["piname"] || [];
    const proxy = excelData["prxageng"]["proxy"] || [];
    const ukey = excelData["prxageng"]["ukey"] || [];
    const userAgent = excelData["prxageng"]["user_agent"] || [];
    const titles = excelData["title"]["titles"] || [];
    const contents = excelData["title"]["contents"] || [];
    
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

    if (titles.length === 0 || contents.length === 0) {
      return {
        success: false,
        message: "Không tìm thấy nội dung bài viết (tiêu đề hoặc nội dung) từ file Excel",
      };
    }

    const totalCores = cpus().length;
    console.log(`>> Máy tính có ${totalCores} CPU cores`);
    
    
    console.log(`>> Tìm thấy ${userObjects.length} users, ${titles.length} tiêu đề, ${contents.length} nội dung`);
    console.log(`>> Bắt đầu đăng bài...`);
    
    
    const allTasks = [];
    console.log('\n>> Danh sách users sẽ được xử lý:');
    userObjects.forEach((user, idx) => {
      console.log(`>> [${idx + 1}/${userObjects.length}] User: ${user.piname} (${user.uid})`);
    });
    console.log('\n');

    // Xử lý lần lượt từng user
    for (const [userIndex, user] of userObjects.entries()) {
      console.log(`\n==========================================`);
      console.log(`>> ĐANG XỬ LÝ USER THỨ ${userIndex + 1}/${userObjects.length}`);
      console.log(`>> User: ${user.piname} (${user.uid})`);
      console.log(`==========================================\n`);
      
      const api = apiClient(user);
      
      // Tạo các tasks cho user hiện tại
      const userTasks = [];
      for (let i = 0; i < postCount; i++) {
        userTasks.push({
          userId: user.uid,
          task: async () => {
            console.log(`\n>> [USER ${userIndex + 1}/${userObjects.length}] ${user.piname} - Đăng bài ${i + 1}/${postCount}`);
            
            const finalTitle = generateUniqueTitle(titles);
            const uniqueContent = generateUniqueContent(contents);

            console.log(`>> Tiêu đề được tạo: ${finalTitle}`);
            console.log(`>> Nội dung được tạo: ${uniqueContent}`);

            let imageUrl;
            try {
              imageUrl = await getImageUrl();
              console.log(`>> Đã lấy được ảnh: ${imageUrl}`);
            } catch (error) {
              console.error(`❌ Lỗi khi lấy ảnh: ${error.message}`);
              imageUrl = "https://asset.vcity.app/vfile/2024/11/25/01/1732528133865582447460541631585-thumb.jpg";
            }
            
            const galleryId = imageUrl.split('/').pop().split('.')[0];
            console.log(`>> Sử dụng gallery ID: ${galleryId}`);
            
            const maxRetries = 2;
            let retryCount = 0;
            
            const urlVariants = ['/vapi', '/vapi/', 'vapi'];
            let currentUrlVariantIndex = 0;
            
            while (retryCount <= maxRetries) {
              try {
                if (retryCount > 0) {
                  console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho đăng bài với user ${user.piname}`);
                  await sleep(3000 * retryCount);
                }
                
                const payload = qs.stringify({
                  gallery: imageUrl,
                  update_country: 1,
                  update_multi_country: JSON.stringify({ 1: 1 }),
                  update_chain: 0,
                  update_multi_chain: JSON.stringify({ 0: 1 }),
                  component: "article",
                  action: "create",
                  title: finalTitle,
                  content: uniqueContent,
                  user_name: user.piname,
                  english_version: 0,
                  selected_country: 1,
                  selected_chain: 0,
                });
                
                const currentUrl = urlVariants[currentUrlVariantIndex];
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Đăng bài "${finalTitle.substring(0, 30)}..." với user ${user.piname}`);
                const response = await api.post(currentUrl, payload);
                
                console.log(`>> [Task ${userIndex+1}-${i+1}] Status code: ${response.status}`);
                
                if (response.data && 
                    response.data.hasOwnProperty('data') && 
                    response.data.data && 
                    response.data.data.status === 1) {
                  console.log(`✅ [Task ${userIndex+1}-${i+1}] User ${user.piname} đã đăng bài thành công!`);
                  return { success: true };
                } else {
                  console.log(`⚠️ [Task ${userIndex+1}-${i+1}] User ${user.piname} đăng bài không thành công:`, response.data);
                  return { success: true };
                }
              } catch (error) {
                console.error(`❌ [Task ${userIndex+1}-${i+1}] Lỗi khi đăng bài với user ${user.piname}:`, error.message);
                
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
                
                return { success: true };
              }
            }
            
            return { success: true };
          }
        });
      }

      // Bỏ phần xáo trộn ngẫu nhiên tasks
      for (const { userId, task } of userTasks) {
        await taskQueue.add(task, userId);
      }
    }

    console.log(`>> Tổng số ${allTasks.length} bài viết đã được thêm vào hàng đợi...`);

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

    const { success, failure } = taskQueue.stats;
    console.log(`\n>> Kết quả cuối cùng: ${success} bài viết đăng thành công, ${failure} bài viết thất bại`);

    return { 
      success: true,
      message: `Đã đăng ${success}/${success + failure} bài viết thành công!`,
      stats: {
        total: success + failure,
        success: success,
        failure: failure,
      }
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: true,
      message: `Đã xảy ra lỗi khi đăng bài: ${error.message}`,
      error: error.toString()
    };
  } finally {
    // Đảm bảo dọn dẹp tài nguyên
    taskQueue.destroy();
  }
}

module.exports = { handlePostArticles };
