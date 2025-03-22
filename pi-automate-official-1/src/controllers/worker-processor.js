const apiClient = require("../api/apiClient");
const getImageUrl = require("../services/serviceGetImage");
const ExcelReaderService = require("../models/excelSheed");
const qs = require("qs");
const path = require("path");

// Gửi log đến master process
function sendLog(message) {
  if (process.send) {
    process.send({ type: 'log', data: message });
  }
  console.log(`[Worker ${process.pid}] ${message}`);
}

class WorkerProcessor {
  constructor() {
    this.taskQueue = [];
    this.concurrencyLimit = 50; // Số lượng tác vụ đồng thời tối đa trong một worker
    this.runningTasks = 0;
    this.results = {
      success: 0,
      failure: 0,
      completed: 0,
      total: 0
    };

    sendLog(`Worker ${process.pid} đã khởi động và đang chờ nhiệm vụ...`);

    // Lắng nghe message từ master process
    process.on('message', (message) => {
      if (message.type === 'accounts') {
        this.processAccounts(message.data);
      }
    });

    // Interval để gửi tiến trình
    this.progressInterval = setInterval(() => {
      this.reportProgress();
    }, 2000);

    // Xử lý khi worker nhận lệnh thoát
    process.on('SIGTERM', () => {
      sendLog('Nhận lệnh thoát. Đang dọn dẹp tài nguyên...');
      this.cleanup();
      process.exit(0);
    });
  }

  // Dọn dẹp tài nguyên
  cleanup() {
    clearInterval(this.progressInterval);
    this.taskQueue = [];
  }

  // Gửi tiến trình về master process
  reportProgress() {
    const { success, failure, completed, total } = this.results;
    
    if (completed > 0 && process.send) {
      process.send({
        type: 'progress',
        data: {
          success: success,
          failure: failure,
          completed: completed,
          total: total,
          pid: process.pid
        }
      });
      
      // Hiển thị tiến độ 
      const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
      sendLog(`Tiến độ: ${percent}% | Thành công: ${success}, Thất bại: ${failure}, Hoàn thành: ${completed}/${total}`);
      
      // Reset các biến đếm để không bị đếm lại
      this.results.success = 0;
      this.results.failure = 0;
      this.results.completed = 0;
    }

    // Kiểm tra nếu đã hoàn thành tất cả công việc
    if (this.results.total > 0 && completed >= this.results.total && this.taskQueue.length === 0 && this.runningTasks === 0) {
      if (process.send) {
        process.send({
          type: 'complete',
          data: {
            pid: process.pid
          }
        });
      }
    }
  }

  // Xử lý danh sách tài khoản
  async processAccounts(data) {
    try {
      const { accounts, postCount } = data;
      
      if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
        sendLog("Không nhận được dữ liệu tài khoản hoặc danh sách trống!");
        return;
      }
      
      sendLog(`Nhận được ${accounts.length} tài khoản, ${postCount} bài/tài khoản`);
      
      // Đọc dữ liệu nội dung từ Excel (chỉ cần đọc sheets liên quan)
      const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
      sendLog(`Đọc dữ liệu từ file: ${excelFilePath}`);
      
      const excelReader = new ExcelReaderService(excelFilePath);
      const excelData = excelReader.readAllSheets();
      
      const titles = excelData["title"]["titles"] || [];
      const contents = excelData["title"]["contents"] || [];
      
      if (titles.length === 0 || contents.length === 0) {
        sendLog("Không có dữ liệu tiêu đề hoặc nội dung!");
        return;
      }
      
      sendLog(`Đọc được ${titles.length} tiêu đề và ${contents.length} nội dung`);
      
      // Thiết lập tổng số task
      this.results.total = accounts.length * postCount;
      
      // Tạo và thực thi các tác vụ đăng bài
      for (const user of accounts) {
        sendLog(`Chuẩn bị đăng bài cho user: ${user.piname}`);
        
        for (let i = 0; i < postCount; i++) {
          this.taskQueue.push(async () => {
            return this.postArticle(user, i + 1, postCount, titles, contents);
          });
        }
      }
      
      sendLog(`Đã thêm ${this.taskQueue.length} tác vụ vào hàng đợi`);
      
      // Bắt đầu xử lý hàng đợi
      for (let i = 0; i < this.concurrencyLimit; i++) {
        this.processQueue();
      }
    } catch (error) {
      sendLog(`Lỗi khi xử lý tài khoản: ${error.message}`);
      
      if (process.send) {
        process.send({
          type: 'error',
          data: {
            error: error.message,
            stack: error.stack
          }
        });
      }
    }
  }
  
  // Xử lý hàng đợi tác vụ
  async processQueue() {
    if (this.taskQueue.length === 0 || this.runningTasks >= this.concurrencyLimit) {
      return;
    }
    
    this.runningTasks++;
    const task = this.taskQueue.shift();
    
    try {
      const result = await task();
      if (result.success) {
        this.results.success++;
      } else {
        this.results.failure++;
      }
    } catch (error) {
      sendLog(`Lỗi khi thực thi tác vụ: ${error.message}`);
      this.results.failure++;
    } finally {
      this.results.completed++;
      this.runningTasks--;
      
      // Tiếp tục xử lý hàng đợi
      setImmediate(() => this.processQueue());
    }
  }
  
  // Đăng một bài viết
  async postArticle(user, currentIndex, totalPosts, titles, contents) {
    try {
      sendLog(`User ${user.piname} - Đăng bài ${currentIndex}/${totalPosts}`);
      
      const api = apiClient(user);
      
      // Tạo nội dung bài viết
      const finalTitle = this.generateUniqueTitle(titles);
      const uniqueContent = this.generateUniqueContent(contents);
      
      sendLog(`Tiêu đề: ${finalTitle.substring(0, 30)}...`);
      
      // Lấy ảnh
      let imageUrl;
      try {
        imageUrl = await getImageUrl();
        sendLog(`Lấy ảnh thành công: ${imageUrl.substring(0, 40)}...`);
      } catch (error) {
        sendLog(`Lỗi khi lấy ảnh: ${error.message}`);
        imageUrl = "https://asset.vcity.app/vfile/2024/11/25/01/1732528133865582447460541631585-thumb.jpg";
      }
      
      // Đăng bài
      const maxRetries = 2;
      let retryCount = 0;
      const urlVariants = ['/vapi', '/vapi/', 'vapi'];
      let currentUrlVariantIndex = 0;
      
      while (retryCount <= maxRetries) {
        try {
          if (retryCount > 0) {
            sendLog(`Thử lại lần ${retryCount}/${maxRetries}`);
            await this.sleep(3000 * retryCount);
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
          sendLog(`Gọi API: ${currentUrl}`);
          
          const response = await api.post(currentUrl, payload);
          
          if (response.data && 
              response.data.hasOwnProperty('data') && 
              response.data.data && 
              response.data.data.status === 1) {
            sendLog(`✅ User ${user.piname} đăng bài thành công`);
            return { success: true };
          } else {
            sendLog(`⚠️ User ${user.piname} đăng bài không thành công: ${JSON.stringify(response.data)}`);
            return { success: false };
          }
        } catch (error) {
          sendLog(`❌ Lỗi đăng bài: ${error.message}`);
          
          if (error.response) {
            if ([404, 429, 500, 502, 503, 504].includes(error.response.status)) {
              retryCount++;
              if (retryCount <= maxRetries) {
                const delayTime = error.response.status === 429 ? 10000 : 3000 * retryCount;
                
                if (error.response.status === 404) {
                  currentUrlVariantIndex = (currentUrlVariantIndex + 1) % urlVariants.length;
                }
                
                await this.sleep(delayTime);
                continue;
              }
            }
          }
          
          return { success: false };
        }
      }
      
      return { success: false };
    } catch (error) {
      sendLog(`Lỗi không xử lý được: ${error.message}`);
      return { success: false };
    }
  }
  
  // Các hàm tiện ích
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  splitIntoWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0);
  }
  
  splitIntoPhrases(text) {
    return text.split(/[,.!?;]/)
      .map(chunk => chunk.trim())
      .filter(chunk => chunk.length > 0);
  }
  
  getRandomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
  }
  
  generateMixedContent(sourceTexts, minParts = 2, maxParts = 4) {
    const wordPool = sourceTexts.reduce((acc, text) => {
      if (text) {
        acc.push(...this.splitIntoWords(text));
      }
      return acc;
    }, []);
  
    const phrasePool = sourceTexts.reduce((acc, text) => {
      if (text) {
        acc.push(...this.splitIntoPhrases(text));
      }
      return acc;
    }, []);
  
    const mixingStyle = Math.floor(Math.random() * 4);
    const parts = [];
    const numParts = Math.floor(Math.random() * (maxParts - minParts + 1)) + minParts;
  
    switch (mixingStyle) {
      case 0: 
        for (let i = 0; i < numParts; i++) {
          parts.push(this.getRandomElement(phrasePool));
        }
        return parts.join(', ');
  
      case 1: 
        for (let i = 0; i < numParts + 2; i++) {
          parts.push(this.getRandomElement(wordPool));
        }
        return parts.join(' ');
  
      case 2: 
        for (let i = 0; i < numParts; i++) {
          if (Math.random() > 0.5) {
            parts.push(this.getRandomElement(phrasePool));
          } else {
            const numWords = Math.floor(Math.random() * 3) + 1;
            const words = [];
            for (let j = 0; j < numWords; j++) {
              words.push(this.getRandomElement(wordPool));
            }
            parts.push(words.join(' '));
          }
        }
        return parts.join(', ');
  
      case 3: 
        const mainPhrase = this.getRandomElement(phrasePool);
        const words = [];
        for (let i = 0; i < 2; i++) {
          words.push(this.getRandomElement(wordPool));
        }
        return `${mainPhrase} ${words.join(' ')}`;
    }
  }
  
  generateUniqueTitle(titles) {
    const title = this.generateMixedContent(titles, 2, 3);
    return `${title}`;
  }
  
  generateUniqueContent(contents) {
    return this.generateMixedContent(contents, 3, 5);
  }
}

// Khởi tạo worker processor
try {
  sendLog("Khởi động worker processor...");
  new WorkerProcessor();
} catch (err) {
  if (process.send) {
    process.send({ type: 'error', data: { error: err.message, stack: err.stack } });
  }
  console.error(`[Worker ${process.pid}] Lỗi khởi tạo: ${err.message}`);
} 