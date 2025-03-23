const cluster = require('cluster');
const os = require('os');
const { EventEmitter } = require('events');
const ExcelReaderService = require("../models/excelSheed");
const path = require("path");

class ClusterManager extends EventEmitter {
  constructor(options = {}) {
    super();
    // Tính toán số lượng worker tối ưu - mặc định để lại 1 core cho hệ thống
    this.numCPUs = options.numWorkers || Math.max(1, os.cpus().length - 1);
    // Số lượng luồng đồng thời tối đa cho mỗi worker
    this.workerConcurrencyLimit = options.concurrencyLimit || process.env.MAX_CONCURRENCY 
      ? parseInt(process.env.MAX_CONCURRENCY, 10)
      : 200; 
    this.workers = [];
    this.workersData = new Map(); // Lưu trữ dữ liệu cho mỗi worker
    this.results = {
      total: 0,
      success: 0,
      failure: 0,
      completed: 0,
      piknowedPostIds: [] // Thêm danh sách ID bài đã PiKnow
    };
    this.progressInterval = null;
    this.isShuttingDown = false;
  }

  // Khởi tạo master process và worker processes
  async initialize() {
    if (cluster.isPrimary) {
      console.log(`Master process ${process.pid} đang chạy`);
      console.log(`Khởi tạo ${this.numCPUs} worker processes...`);
      
      // Đảm bảo workerConcurrencyLimit là số hợp lệ
      if (isNaN(this.workerConcurrencyLimit) || this.workerConcurrencyLimit <= 0) {
        this.workerConcurrencyLimit = 200;
        console.log(`Phát hiện giá trị không hợp lệ, đặt lại giới hạn luồng mặc định: ${this.workerConcurrencyLimit}`);
      }
      
      console.log(`Mỗi worker được cấu hình với ${this.workerConcurrencyLimit} luồng đồng thời`);

      // Xử lý sự kiện khi nhận lệnh thoát
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());

      // Khởi tạo workers
      for (let i = 0; i < this.numCPUs; i++) {
        this.createWorker();
      }

      // Xử lý khi worker kết thúc
      cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} đã thoát với code: ${code} và signal: ${signal}`);
        
        // Loại bỏ worker khỏi danh sách
        this.workers = this.workers.filter(w => w.id !== worker.id);
        
        // Khởi động lại worker nếu không phải đang shutdown
        if (!this.isShuttingDown && code !== 0) {
          console.log(`Đang khởi động lại worker...`);
          this.createWorker();
        }
      });

      // Bắt đầu hiển thị tiến độ định kỳ
      this.startProgressReporting();

      return true;
    } else {
      console.log(`Worker ${process.pid} đã khởi động`);
      return false;
    }
  }

  // Tạo worker mới
  createWorker() {
    // Đảm bảo giá trị concurrencyLimit là số hợp lệ trước khi truyền vào worker
    const validConcurrencyLimit = isNaN(this.workerConcurrencyLimit) ? 2 : this.workerConcurrencyLimit;
    
    const worker = cluster.fork({
      MAX_CONCURRENCY: validConcurrencyLimit.toString() // Chuyển thành string để đảm bảo truyền đúng
    });
    
    this.workers.push(worker);
    this.workersData.set(worker.id, {
      pid: worker.process.pid,
      status: 'idle',
      success: 0,
      failure: 0,
      completed: 0,
      startTime: Date.now(),
      concurrencyLimit: validConcurrencyLimit
    });

    // Lắng nghe message từ worker
    worker.on('message', (message) => {
      if (message.type === 'progress') {
        this.updateProgress(worker.id, message.data);
      } else if (message.type === 'complete') {
        this.handleWorkerComplete(worker.id, message.data);
      } else if (message.type === 'log') {
        console.log(`[Worker ${worker.process.pid}] ${message.data}`);
      } else if (message.type === 'error') {
        console.error(`[Worker ${worker.process.pid}] Error: ${message.data.error}`);
      }
    });

    return worker;
  }

  // Thiết lập số lượng luồng đồng thời cho tất cả worker
  setAllWorkerConcurrency(limit) {
    if (typeof limit !== 'number' || limit <= 0) {
      console.error(`Giá trị giới hạn luồng không hợp lệ: ${limit}`);
      return;
    }

    console.log(`Đang đặt giới hạn luồng ${limit} cho tất cả worker...`);
    this.workerConcurrencyLimit = limit;

    // Cập nhật cho tất cả worker đang hoạt động
    for (const worker of this.workers) {
      if (worker.isConnected()) {
        worker.send({
          type: 'set-concurrency',
          data: {
            concurrencyLimit: limit
          }
        });
      }
    }
  }

  // Tắt tất cả worker
  shutdown() {
    console.log('Nhận lệnh thoát. Đang dừng tất cả worker processes...');
    this.isShuttingDown = true;
    
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    
    for (const worker of this.workers) {
      console.log(`Gửi lệnh SIGTERM đến worker ${worker.process.pid}...`);
      worker.kill('SIGTERM');
    }
    
    // Đảm bảo tất cả worker thoát sau 5 giây
    setTimeout(() => {
      for (const worker of this.workers) {
        if (worker.isConnected()) {
          console.log(`Force kill worker ${worker.process.pid}...`);
          worker.kill('SIGKILL');
        }
      }
    }, 5000);
  }

  // Bắt đầu hiển thị tiến độ định kỳ
  startProgressReporting() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    
    this.progressInterval = setInterval(() => {
      this.displayProgress();
    }, 3000);
  }

  // Hiển thị tiến độ tổng quát
  displayProgress() {
    const percent = this.results.total > 0 
      ? Math.floor((this.results.completed / this.results.total) * 100) 
      : 0;
    
    const bar = Array(20).fill('▒')
      .map((char, i) => i < Math.floor(percent / 5) ? '█' : '▒')
      .join('');

    console.log(`\n-------- TRẠNG THÁI TIẾN ĐỘ --------`);
    console.log(`[${bar}] ${percent}% (${this.results.completed}/${this.results.total})`);
    console.log(`✅ Thành công: ${this.results.success} | ❌ Thất bại: ${this.results.failure}`);
    console.log(`🧵 Worker đang chạy: ${this.workers.length} | 🔄 Luồng mỗi worker: ${this.workerConcurrencyLimit}`);
    
    // Hiển thị thông tin chi tiết các worker
    console.log(`\n-------- CHI TIẾT WORKER --------`);
    for (const [workerId, data] of this.workersData.entries()) {
      if (data.completed > 0) {
        console.log(`Worker ${data.pid}: Hoàn thành ${data.completed}, Thành công: ${data.success}, Thất bại: ${data.failure}, Luồng: ${data.concurrencyLimit || this.workerConcurrencyLimit}`);
      }
    }
    console.log(`------------------------------------------\n`);
    
    this.emit('progress', this.results);
  }

  // Phân phối tài khoản cho các worker để ĐĂNG BÀI
  async distributeAccounts(totalPostCount) {
    if (!cluster.isPrimary) return;

    try {
      const userObjects = await this._readUserAccounts();
      
      if (userObjects.length === 0) {
        throw new Error("Không có tài khoản nào đọc được từ file Excel!");
      }
      
      // Chỉ giữ lại các worker đang hoạt động
      const activeWorkers = this.workers.filter(worker => worker.isConnected());
      
      if (activeWorkers.length === 0) {
        throw new Error("Không có worker nào đang hoạt động!");
      }
      
      // Phân chia danh sách tài khoản cho các worker
      const accountsPerWorker = Math.max(1, Math.ceil(userObjects.length / activeWorkers.length));
      console.log(`Mỗi worker sẽ xử lý khoảng ${accountsPerWorker} tài khoản`);
      
      for (let i = 0; i < activeWorkers.length; i++) {
        const worker = activeWorkers[i];
        const startIndex = i * accountsPerWorker;
        const endIndex = Math.min(startIndex + accountsPerWorker, userObjects.length);
        
        if (startIndex >= userObjects.length) {
          // Worker này không có tài khoản nào để xử lý
          console.log(`Worker ${worker.process.pid} không được phân công tài khoản nào`);
          worker.send({
            type: 'accounts',
            data: {
              accounts: [],
              postCount: totalPostCount
            }
          });
          continue;
        }
        
        const workerAccounts = userObjects.slice(startIndex, endIndex);
        
        // Cập nhật thông tin worker
        const workerData = this.workersData.get(worker.id);
        if (workerData) {
          workerData.status = 'busy';
          workerData.accounts = workerAccounts.length;
          workerData.totalTasks = workerAccounts.length * totalPostCount;
        }
        
        // Gửi danh sách tài khoản cho worker
        worker.send({
          type: 'accounts',
          data: {
            accounts: workerAccounts,
            postCount: totalPostCount
          }
        });
        
        console.log(`Đã gửi ${workerAccounts.length} tài khoản cho worker ${worker.process.pid}`);
      }
      
      // Cập nhật tổng số tác vụ
      this.results.total = userObjects.length * totalPostCount;
      console.log(`Tổng số bài viết dự kiến: ${this.results.total}`);
    } catch (error) {
      console.error('Lỗi khi phân phối tài khoản:', error);
      this.emit('error', error);
    }
  }

  // Phân phối tài khoản cho các worker để PIKNOW
  async distributePiKnowAccounts(totalPiKnowCount) {
    if (!cluster.isPrimary) return;

    try {
      const userObjects = await this._readUserAccounts();
      
      if (userObjects.length === 0) {
        throw new Error("Không có tài khoản nào đọc được từ file Excel!");
      }
      
      // Chỉ giữ lại các worker đang hoạt động
      const activeWorkers = this.workers.filter(worker => worker.isConnected());
      
      if (activeWorkers.length === 0) {
        throw new Error("Không có worker nào đang hoạt động!");
      }
      
      // Phân chia danh sách tài khoản cho các worker
      const accountsPerWorker = Math.max(1, Math.ceil(userObjects.length / activeWorkers.length));
      console.log(`Mỗi worker sẽ xử lý khoảng ${accountsPerWorker} tài khoản cho PiKnow`);
      
      for (let i = 0; i < activeWorkers.length; i++) {
        const worker = activeWorkers[i];
        const startIndex = i * accountsPerWorker;
        const endIndex = Math.min(startIndex + accountsPerWorker, userObjects.length);
        
        if (startIndex >= userObjects.length) {
          // Worker này không có tài khoản nào để xử lý
          console.log(`Worker ${worker.process.pid} không được phân công tài khoản nào cho PiKnow`);
          worker.send({
            type: 'piknow-accounts',
            data: {
              accounts: [],
              piknowCount: totalPiKnowCount
            }
          });
          continue;
        }
        
        const workerAccounts = userObjects.slice(startIndex, endIndex);
        
        // Cập nhật thông tin worker
        const workerData = this.workersData.get(worker.id);
        if (workerData) {
          workerData.status = 'busy';
          workerData.accounts = workerAccounts.length;
          workerData.totalTasks = workerAccounts.length * totalPiKnowCount;
        }
        
        // Gửi danh sách tài khoản cho worker
        worker.send({
          type: 'piknow-accounts',
          data: {
            accounts: workerAccounts,
            piknowCount: totalPiKnowCount
          }
        });
        
        console.log(`Đã gửi ${workerAccounts.length} tài khoản cho worker ${worker.process.pid} để PiKnow`);
      }
      
      // Cập nhật tổng số tác vụ
      this.results.total = userObjects.length * totalPiKnowCount;
      console.log(`Tổng số PiKnow dự kiến: ${this.results.total}`);
    } catch (error) {
      console.error('Lỗi khi phân phối tài khoản cho PiKnow:', error);
      this.emit('error', error);
    }
  }

  // Hàm đọc tài khoản từ Excel để tái sử dụng
  async _readUserAccounts() {
    const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
    const excelReader = new ExcelReaderService(excelFilePath);
    const excelData = excelReader.readAllSheets();
    
    const uid = excelData["prxageng"]["uid"] || [];
    const piname = excelData["prxageng"]["piname"] || [];
    const proxy = excelData["prxageng"]["proxy"] || [];
    const ukey = excelData["prxageng"]["ukey"] || [];
    const userAgent = excelData["prxageng"]["user_agent"] || [];
    
    const userObjects = uid.filter(user => user !== null).map((user, index) => {
      if (index >= proxy.length) {
        console.error(`Không đủ thông tin proxy cho user ${index + 1}`);
        return null;
      }
      
      try {
        const newProxy = proxy[index].split(":");
        return {
          uid: user,
          piname: piname[index] || `user_${user}`,
          ukey: ukey[index] || '',
          userAgent: userAgent[index] || 'Mozilla/5.0',
          proxy: {
            host: newProxy[0],
            port: newProxy[1],
            name: newProxy[2],
            password: newProxy[3],
          },
        };
      } catch (error) {
        console.error(`Lỗi xử lý user ${index + 1}: ${error.message}`);
        return null;
      }
    }).filter(user => user !== null);

    console.log(`Đọc được ${userObjects.length} tài khoản từ file Excel`);
    return userObjects;
  }

  // Cập nhật tiến trình từ các worker
  updateProgress(workerId, progressData) {
    try {
      if (!progressData) return;

      const { success, failure, completed, piknowedPostIds, likeResult } = progressData;
      
      // Cập nhật thông tin chi tiết của worker
      const workerData = this.workersData.get(workerId);
      if (workerData) {
        workerData.success += success || 0;
        workerData.failure += failure || 0;
        workerData.completed += completed || 0;
        workerData.lastUpdate = Date.now();
      }
      
      // Cập nhật tổng hợp
      this.results.success += success || 0;
      this.results.failure += failure || 0;
      this.results.completed += completed || 0;
      
      // Thêm ID bài đã PiKnow vào danh sách tổng hợp
      if (piknowedPostIds && Array.isArray(piknowedPostIds)) {
        this.results.piknowedPostIds = [
          ...this.results.piknowedPostIds,
          ...piknowedPostIds
        ];
      }
      
      // Nếu là LikeEachOtherManager, xử lý kết quả like
      if (likeResult && typeof this.updateLikeResult === 'function') {
        try {
          this.updateLikeResult(workerId, likeResult);
        } catch (error) {
          console.error(`Lỗi khi xử lý kết quả like cho worker ${workerId}:`, error);
        }
      }
    } catch (error) {
      console.error(`Lỗi không xử lý được trong updateProgress:`, error);
    }
  }

  // Xử lý khi worker hoàn thành công việc
  handleWorkerComplete(workerId, data) {
    const workerData = this.workersData.get(workerId);
    if (workerData) {
      workerData.status = 'completed';
      console.log(`Worker ${workerData.pid} đã hoàn thành công việc!`);
    }
    
    // Kiểm tra nếu tất cả worker đã hoàn thành
    const allCompleted = Array.from(this.workersData.values())
      .every(data => data.status === 'completed' || data.status === 'idle' || !data.accounts);
    
    if (allCompleted || this.results.completed >= this.results.total) {
      this.displayProgress();
      console.log(`\n>> Kết quả cuối cùng: ${this.results.success} tác vụ thành công, ${this.results.failure} tác vụ thất bại`);
      
      if (this.progressInterval) {
        clearInterval(this.progressInterval);
      }
      
      this.emit('complete', this.results);
    }
  }
}

module.exports = ClusterManager; 