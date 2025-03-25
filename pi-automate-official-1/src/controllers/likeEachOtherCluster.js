const path = require('path');
const { EventEmitter } = require('events');
const ExcelReaderService = require('../models/excelSheed');
const { cpus } = require('os');
const cluster = require('cluster');
const ClusterManager = require('./cluster-manager');

// Đối tượng để quản lý Like Chéo
class LikeEachOtherManager extends ClusterManager {
  constructor(options = {}) {
    super(options);
    
    // Thêm thông tin phân bổ like
    this.likeDistribution = new Map(); // Lưu trữ thông tin phân bổ like
    this.likeCount = options.likeCount || 12; // Số lượng like mỗi tài khoản cần thực hiện
    this.results.likeStats = {}; // Thống kê về like
  }

  // Ghi đè phương thức đọc tài khoản từ lớp cha để đọc thêm sheet "likeEachOther" nếu có
  async _readUserAccounts() {
    // Gọi phương thức của lớp cha để lấy thông tin cơ bản từ sheet "prxageng"
    const baseUserObjects = await super._readUserAccounts();
    
    if (baseUserObjects.length === 0) {
      throw new Error("Không đọc được thông tin tài khoản từ sheet 'prxageng'");
    }
    
    try {
      // Đọc thêm sheet "likeEachOther" nếu cần
      const excelFilePath = path.join(__dirname, "../data/PI.xlsx");
      const excelReader = new ExcelReaderService(excelFilePath);
      const excelData = excelReader.readAllSheets();
      
      // Kiểm tra xem có sheet "likeEachOther" không
      if (excelData["likeEachOther"]) {
        console.log("Tìm thấy sheet 'likeEachOther', kiểm tra thông tin...");
        
        // Lấy dữ liệu từ sheet likeEachOther
        const targetUids = excelData["likeEachOther"]["profileId"] || [];
        
        // Nếu có dữ liệu trong sheet likeEachOther, có thể sử dụng để điều chỉnh phân bổ like
        if (targetUids.length > 0) {
          console.log(`Tìm thấy ${targetUids.filter(uid => uid !== null).length} uid mục tiêu trong sheet 'likeEachOther'`);
        }
      } else {
        console.log("Không tìm thấy sheet 'likeEachOther', chỉ sử dụng dữ liệu từ sheet 'prxageng'");
      }
      
      return baseUserObjects;
    } catch (error) {
      console.error(`Lỗi khi đọc thêm thông tin từ sheet 'likeEachOther': ${error.message}`);
      return baseUserObjects;
    }
  }

  // Phân bổ like chéo đồng đều cho tất cả tài khoản
  async distributeLikeAssignments() {
    if (!cluster.isPrimary) return;

    try {
      // Đọc danh sách tài khoản từ Excel
      const userObjects = await this._readUserAccounts();
      
      if (userObjects.length === 0) {
        throw new Error("Không có tài khoản nào đọc được từ file Excel!");
      }
      
      // Fix cứng số lượng like là 12
      this.likeCount = 12;

      // Kiểm tra nếu số lượng tài khoản quá ít
      if (userObjects.length < 2) {
        throw new Error(`Cần ít nhất 2 tài khoản để thực hiện like chéo, hiện chỉ có ${userObjects.length} tài khoản!`);
      }
      
      console.log(`Tạo phân bổ like chéo cho ${userObjects.length} tài khoản, cố gắng đạt mục tiêu ${this.likeCount} like/tài khoản...`);
      
      // Tạo danh sách phân bổ like chéo đều cho mỗi tài khoản
      this.likeDistribution = this._createEvenLikeDistribution(userObjects);
      
      // In thông tin phân bổ like
      console.log(`Đã tạo phân bổ like chéo thành công! Mỗi tài khoản sẽ cố gắng like ${this.likeCount} tài khoản khác.`);
      
      // Phân bổ tài khoản cho các worker
      await this.distributeLikeTasksToWorkers(userObjects);
      
      return true;
    } catch (error) {
      console.error('Lỗi khi phân bổ like chéo:', error);
      this.emit('error', error);
      return false;
    }
  }
  
  // Tạo phân bổ like chéo đồng đều theo thuật toán từ handleLikeEachOther
  _createEvenLikeDistribution(accounts) {
    const n = accounts.length;
    const likeMap = new Map();
    
    // Khởi tạo danh sách cần like cho mỗi tài khoản
    accounts.forEach(user => {
      if (user && user.uid) {
        likeMap.set(user.uid, []);
      }
    });

    // Kiểm tra số lượng tài khoản
    if (n <= 1) {
      console.error(`Cần ít nhất 2 tài khoản để thực hiện like chéo, hiện có ${n} tài khoản`);
      return likeMap;
    }

    // Kiểm tra nếu không đủ tài khoản
    if (n < this.likeCount + 1) {
      console.warn(`⚠️ Không đủ tài khoản để mỗi tài khoản like đúng ${this.likeCount} tài khoản khác.`);
      console.warn(`⚠️ Có ${n} tài khoản, nhưng cần ít nhất ${this.likeCount + 1} tài khoản.`);
      console.warn(`⚠️ Mỗi tài khoản sẽ chỉ có thể like tối đa ${n - 1} tài khoản khác.`);
    }

    console.log(`Đang tạo phân bổ like chéo cho ${n} tài khoản, mục tiêu ${this.likeCount} like/tài khoản...`);

    // Tạo ma trận theo dõi cặp đã like
    const usedPairs = new Map();
    accounts.forEach(user => {
      if (user && user.uid) {
        usedPairs.set(user.uid, new Set());
      }
    });

    // Đảm bảo mỗi tài khoản không tự like chính mình
    accounts.forEach(user => {
      if (user && user.uid && usedPairs.has(user.uid)) {
        usedPairs.get(user.uid).add(user.uid);
      }
    });

    // Theo dõi số lượng like đã phân phối cho mỗi tài khoản
    const likesGiven = new Map();
    const likesReceived = new Map();
    accounts.forEach(user => {
      if (user && user.uid) {
        likesGiven.set(user.uid, 0);
        likesReceived.set(user.uid, 0);
      }
    });

    // Số lượng like tối đa mỗi tài khoản có thể thực hiện
    const maxLikesPerAccount = Math.min(this.likeCount, n - 1);

    // Thực hiện phân phối like
    let iterations = 0;
    const MAX_ITERATIONS = this.likeCount * n * 2; // Giới hạn số vòng lặp để tránh vòng lặp vô hạn
    
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      
      let allDone = true; // Kiểm tra xem tất cả tài khoản đã đạt đến số like cần thiết chưa
      
      // Sắp xếp tài khoản ưu tiên theo số lượng like đã nhận (ít nhất lên đầu)
      const accountsByReceived = [...accounts]
        .filter(acc => acc && acc.uid && likesReceived.has(acc.uid))
        .sort((a, b) => likesReceived.get(a.uid) - likesReceived.get(b.uid));
      
      // Duyệt qua các tài khoản cần nhận like
      for (const target of accountsByReceived) {
        // Bỏ qua nếu tài khoản đã nhận đủ like
        if (likesReceived.get(target.uid) >= maxLikesPerAccount) {
          continue;
        }
        
        allDone = false; // Vẫn còn tài khoản chưa nhận đủ like
        
        // Lọc các tài khoản có thể like cho target
        const potentialLikers = accounts.filter(liker => 
          liker && liker.uid && // Tài khoản hợp lệ
          liker.uid !== target.uid && // Không tự like
          !usedPairs.get(liker.uid).has(target.uid) && // Chưa like cho target
          likesGiven.get(liker.uid) < maxLikesPerAccount // Chưa đạt giới hạn like
        );
        
        if (potentialLikers.length === 0) {
          continue; // Không còn tài khoản nào có thể like cho target
        }
        
        // Sắp xếp theo số lượng like đã cho (ít nhất lên đầu)
        potentialLikers.sort((a, b) => likesGiven.get(a.uid) - likesGiven.get(b.uid));
        
        // Chọn tài khoản đầu tiên để like
        const liker = potentialLikers[0];
        
        // Cập nhật thông tin
        usedPairs.get(liker.uid).add(target.uid);
        likesGiven.set(liker.uid, likesGiven.get(liker.uid) + 1);
        likesReceived.set(target.uid, likesReceived.get(target.uid) + 1);
        
        // Thêm vào likeMap
        likeMap.get(liker.uid).push({
          targetUid: target.uid,
          targetPiname: target.piname
        });
      }
      
      // Nếu tất cả đã xong hoặc không thể phân phối thêm, thoát vòng lặp
      if (allDone) {
        console.log(`Đã hoàn thành phân phối like sau ${iterations} vòng lặp`);
        break;
      }
      
      // Kiểm tra nếu không thể phân phối thêm (không tiến triển)
      if (iterations % n === 0) {
        let canProgress = false;
        
        for (const user of accounts) {
          if (user && user.uid) {
            if (likesGiven.get(user.uid) < maxLikesPerAccount && 
                likesReceived.get(user.uid) < maxLikesPerAccount) {
              // Vẫn có thể tiến triển
              canProgress = true;
              break;
            }
          }
        }
        
        if (!canProgress) {
          console.log(`Phân phối đã đạt mức tối ưu, không thể tiếp tục sau ${iterations} vòng lặp`);
          break;
        }
      }
    }
    
    if (iterations >= MAX_ITERATIONS) {
      console.warn(`⚠️ Đã đạt số lượng vòng lặp tối đa (${MAX_ITERATIONS}). Phân phối có thể chưa hoàn hảo.`);
    }
    
    // Báo cáo kết quả phân phối
    console.log(`\n--- Kết quả phân bổ like ---`);
    
    let perfectDistribution = true;
    let minLikesGiven = Infinity;
    let maxLikesGiven = 0;
    let minLikesReceived = Infinity;
    let maxLikesReceived = 0;
    
    accounts.forEach(user => {
      if (!user || !user.uid) return;
      
      const givenCount = likesGiven.get(user.uid);
      const receivedCount = likesReceived.get(user.uid);
      
      minLikesGiven = Math.min(minLikesGiven, givenCount);
      maxLikesGiven = Math.max(maxLikesGiven, givenCount);
      minLikesReceived = Math.min(minLikesReceived, receivedCount);
      maxLikesReceived = Math.max(maxLikesReceived, receivedCount);
      
      console.log(`Tài khoản ${user.piname}: Like đã cho: ${givenCount}/${maxLikesPerAccount}, Like đã nhận: ${receivedCount}/${maxLikesPerAccount}`);
      
      if (givenCount !== maxLikesPerAccount || receivedCount !== maxLikesPerAccount) {
        perfectDistribution = false;
      }
    });
    
    // Kiểm tra kết quả phân phối
    if (perfectDistribution) {
      console.log(`✅ Phân bổ hoàn hảo! Tất cả ${n} tài khoản đều like và được like đúng ${maxLikesPerAccount} lần.`);
    } else {
      if (n < this.likeCount + 1) {
        console.log(`⚠️ Phân bổ tối ưu với số tài khoản hạn chế. Like đã thực hiện: min=${minLikesGiven}, max=${maxLikesGiven}. Like đã nhận: min=${minLikesReceived}, max=${maxLikesReceived}`);
      } else {
        console.log(`⚠️ Phân bổ chưa hoàn hảo. Like đã thực hiện: min=${minLikesGiven}, max=${maxLikesGiven}. Like đã nhận: min=${minLikesReceived}, max=${maxLikesReceived}`);
      }
    }
    
    return likeMap;
  }
  
  // Phân bổ tài khoản và nhiệm vụ like cho các worker
  async distributeLikeTasksToWorkers(accounts) {
    if (!cluster.isPrimary) return;

    try {
      // Kiểm tra tài khoản hợp lệ
      const validAccounts = accounts.filter(acc => acc && acc.uid);
      if (validAccounts.length === 0) {
        throw new Error("Không có tài khoản hợp lệ nào để xử lý!");
      }

      console.log(`Xác nhận ${validAccounts.length}/${accounts.length} tài khoản hợp lệ`);

      // === VỊ TRÍ 5: KIỂM TRA SỐ LƯỢNG WORKER HỢP LÝ ===
      // [THÊM MỚI] Chỉ giữ lại các worker đang hoạt động
      const activeWorkers = this.workers.filter(worker => worker.isConnected());
      
      if (activeWorkers.length === 0) {
        throw new Error("Không có worker nào đang hoạt động!");
      }
      
      // [THÊM MỚI] Cảnh báo khi có quá nhiều worker so với số tài khoản
      const recommendedWorkers = Math.ceil(validAccounts.length / 50);
      if (activeWorkers.length > recommendedWorkers * 2) {
        console.warn(`⚠️ CẢNH BÁO: Có quá nhiều worker (${activeWorkers.length}) so với số lượng tài khoản (${validAccounts.length})`);
        console.warn(`⚠️ Đề xuất: Chỉ cần khoảng ${recommendedWorkers} worker cho ${validAccounts.length} tài khoản`);
        console.warn(`⚠️ Nhiều worker có thể gây lãng phí tài nguyên và làm chậm tiến trình!`);
      }
      
      console.log(`Có ${activeWorkers.length} worker đang hoạt động (đề xuất: ${recommendedWorkers})`);
      
      // Lấy danh sách bài viết cho mỗi tài khoản
      console.log(`Bắt đầu lấy bài viết đầu tiên cho ${validAccounts.length} tài khoản...`);
      const allUserPosts = await this._fetchUserPosts(validAccounts);
      
      // Đếm số lượng tài khoản có bài viết
      let accountsWithPosts = 0;
      let totalPosts = 0;
      const accountsWithoutPosts = [];
      
      for (const uid in allUserPosts) {
        if (allUserPosts[uid] && allUserPosts[uid].length > 0) {
          accountsWithPosts++;
          totalPosts += allUserPosts[uid].length;
        } else {
          // Tìm thông tin tài khoản để hiển thị
          const account = validAccounts.find(acc => acc.uid == uid);
          if (account) {
            accountsWithoutPosts.push(account.piname);
          }
        }
      }
      
      console.log(`Tìm thấy bài viết cho ${accountsWithPosts}/${validAccounts.length} tài khoản`);
      console.log(`Tổng số bài viết đã tìm thấy: ${totalPosts}`);
      
      if (accountsWithoutPosts.length > 0) {
        console.warn(`⚠️ ${accountsWithoutPosts.length} tài khoản không có bài viết nào:`);
        if (accountsWithoutPosts.length <= 10) {
          console.warn(accountsWithoutPosts.join(', '));
        } else {
          console.warn(accountsWithoutPosts.slice(0, 10).join(', ') + ` và ${accountsWithoutPosts.length - 10} tài khoản khác`);
        }
      }
      
      if (accountsWithPosts === 0) {
        throw new Error("Không tìm thấy bài viết nào để like! Vui lòng kiểm tra lại tài khoản và kết nối.");
      }
      
      // Kiểm tra xem đủ tài khoản để like không
      if (accountsWithPosts < this.likeCount) {
        console.warn(`⚠️ Chỉ có ${accountsWithPosts} tài khoản có bài viết, nhưng mục tiêu là like ${this.likeCount} bài/tài khoản`);
        console.warn(`⚠️ Mỗi tài khoản sẽ chỉ có thể like tối đa ${accountsWithPosts - 1} bài`);
      }
      
      // === CHỈNH SỬA: CẢI THIỆN PHÂN PHỐI NHIỆM VỤ LIKE ===
      // Chia tài khoản cho các worker, chỉ sử dụng đủ số worker cần thiết
      // Mỗi worker nên xử lý ít nhất 10 tài khoản để tránh lãng phí
      const minAccountsPerWorker = 10;
      const idealWorkerCount = Math.max(1, Math.min(
        activeWorkers.length,
        Math.ceil(validAccounts.length / minAccountsPerWorker)
      ));
      
      // Chỉ sử dụng số lượng worker thực sự cần thiết
      const workersToUse = activeWorkers.slice(0, idealWorkerCount);
      
      if (workersToUse.length < activeWorkers.length) {
        console.log(`Chỉ sử dụng ${workersToUse.length}/${activeWorkers.length} worker để xử lý ${validAccounts.length} tài khoản`);
        // Thông báo các worker không được sử dụng
        activeWorkers.slice(idealWorkerCount).forEach(worker => {
          console.log(`Worker ${worker.process.pid} sẽ không được sử dụng trong lần này`);
          
          // Gửi thông báo cho worker không được sử dụng
          worker.send({
            type: 'like-tasks',
            data: {
              accounts: [],
              likeTasks: [],
              userPosts: {}
            }
          });
        });
      }
      
      // Tạo danh sách nhiệm vụ like dựa trên likeDistribution
      const allLikeTasks = [];
      
      for (const user of validAccounts) {
        if (!user || !user.uid) {
          console.warn(`Bỏ qua tài khoản không hợp lệ:`, user);
          continue;
        }
        
        // Lấy danh sách tài khoản cần like từ bản đồ phân phối
        const targetsToLike = this.likeDistribution.get(user.uid) || [];
        
        if (targetsToLike.length === 0) {
          console.warn(`Tài khoản ${user.piname} không có target nào để like`);
          continue;
        }
        
        for (const target of targetsToLike) {
          if (!target || !target.targetUid) {
            console.warn(`Bỏ qua target không hợp lệ cho user ${user.piname}:`, target);
            continue;
          }
          
          // Lấy bài viết đầu tiên của người dùng đích để like
          const targetPosts = allUserPosts[target.targetUid] || [];
          if (targetPosts.length === 0) {
            console.warn(`Không tìm thấy bài viết nào của tài khoản ${target.targetPiname} để like`);
            continue;
          }
          
          // Chọn bài viết đầu tiên để like
          const postToLike = targetPosts[0];
          if (!postToLike) {
            console.warn(`Bài viết của tài khoản ${target.targetPiname} không hợp lệ`);
            continue;
          }
          
          allLikeTasks.push({
            sourceUid: user.uid,
            sourcePiname: user.piname,
            targetUid: target.targetUid,
            targetPiname: target.targetPiname,
            postId: postToLike
          });
        }
      }
      
      // Tổng số nhiệm vụ like
      console.log(`Tạo được ${allLikeTasks.length} nhiệm vụ like tổng cộng`);
      
      if (allLikeTasks.length === 0) {
        throw new Error("Không tạo được nhiệm vụ like nào! Quá trình sẽ dừng lại.");
      }
      
      // === CHỈNH SỬA: Phân phối nhiệm vụ like tối ưu hơn ===
      // Phân nhóm nhiệm vụ theo sourceUid (người thực hiện like)
      const tasksBySource = new Map();
      allLikeTasks.forEach(task => {
        if (!tasksBySource.has(task.sourceUid)) {
          tasksBySource.set(task.sourceUid, []);
        }
        tasksBySource.get(task.sourceUid).push(task);
      });
      
      // Tạo các worker batches, phân tán nhiệm vụ của cùng một người dùng
      const workerBatches = Array.from({length: workersToUse.length}, () => []);
      
      // Lấy số lượng nhiệm vụ lớn nhất của một người dùng
      let maxTasksPerUser = 0;
      tasksBySource.forEach(tasks => {
        maxTasksPerUser = Math.max(maxTasksPerUser, tasks.length);
      });
      
      console.log(`Mỗi người dùng có tối đa ${maxTasksPerUser} nhiệm vụ like`);
      
      // Phân phối theo round-robin cho từng nguồn
      for (let round = 0; round < maxTasksPerUser; round++) {
        let workerIndex = round % workersToUse.length;
        
        // Với mỗi vòng, lấy nhiệm vụ thứ 'round' của mỗi người dùng
        for (const [sourceUid, tasks] of tasksBySource.entries()) {
          if (round < tasks.length) {
            workerBatches[workerIndex].push(tasks[round]);
            workerIndex = (workerIndex + 1) % workersToUse.length;
          }
        }
      }
      
      console.log(`Đã phân phối nhiệm vụ like cho ${workersToUse.length} worker`);
      
      // Phân phối tài khoản cho các worker
      const accountsPerWorker = Math.max(1, Math.ceil(validAccounts.length / workersToUse.length));
      
      let totalTasks = 0;
      let workerWithTasks = 0;
      
      // Gán tài khoản và nhiệm vụ like cho các worker
      for (let i = 0; i < workersToUse.length; i++) {
        const worker = workersToUse[i];
        const startIndex = i * accountsPerWorker;
        const endIndex = Math.min(startIndex + accountsPerWorker, validAccounts.length);
        
        // Lấy danh sách tài khoản cho worker này
        const workerAccounts = validAccounts.slice(startIndex, endIndex);
        
        // Lấy nhiệm vụ like cho worker này
        const likeTasks = workerBatches[i];
        const workerTaskCount = likeTasks.length;
        
        totalTasks += workerTaskCount;
        
        // Kiểm tra nếu worker này có nhiệm vụ
        if (workerTaskCount > 0) {
          workerWithTasks++;
        }
        
        // Cập nhật thông tin worker
        const workerData = this.workersData.get(worker.id);
        if (workerData) {
          workerData.status = workerTaskCount > 0 ? 'busy' : 'idle';
          workerData.accounts = workerAccounts.length;
          workerData.totalTasks = workerTaskCount;
        }
        
        // Gửi danh sách tài khoản và nhiệm vụ like cho worker
        worker.send({
          type: 'like-tasks',
          data: {
            accounts: workerAccounts,
            likeTasks: likeTasks,
            userPosts: allUserPosts
          }
        });
        
        console.log(`Đã gửi ${workerAccounts.length} tài khoản và ${likeTasks.length} nhiệm vụ like cho worker ${worker.process.pid}`);
      }
      
      // === VỊ TRÍ 7: KIỂM TRA KHI KHÔNG CÓ NHIỆM VỤ ===
      // [THAY ĐỔI] Kiểm tra tổng số nhiệm vụ và kết thúc sớm nếu không có
      if (totalTasks === 0) {
        console.error("❌ Không tạo được nhiệm vụ like nào! Quá trình sẽ dừng lại.");
        
        // Báo hiệu hoàn thành với thông báo rõ ràng
        this.emit('complete', {
          success: 0,
          failure: 0,
          total: 0,
          message: "Không có nhiệm vụ like nào được tạo"
        });
        
        // Dừng tất cả worker khi không có nhiệm vụ
        console.log("Đang dừng tất cả các worker do không có nhiệm vụ...");
        this.workers.forEach(worker => {
          if (worker && worker.isConnected()) {
            worker.kill();
          }
        });
        
        return false;
      }
      
      console.log(`Đã phân phối tổng cộng ${totalTasks} nhiệm vụ like cho ${workerWithTasks} worker`);
      console.log(`Mỗi worker xử lý trung bình ${Math.round(totalTasks/workerWithTasks)} nhiệm vụ like`);
      
      // Cập nhật tổng số tác vụ
      this.results.total = totalTasks;
      console.log(`Tổng số nhiệm vụ like dự kiến: ${totalTasks}`);
      
      return true;
    } catch (error) {
      console.error(`❌ Lỗi khi phân bổ nhiệm vụ like cho worker: ${error.message}`);
      this.emit('error', error);
      
      // Báo hiệu hoàn thành với lỗi
      this.emit('complete', {
        success: 0,
        failure: 0,
        total: 0,
        message: `Quá trình bị dừng do lỗi: ${error.message}`
      });
      
      // Chủ động dừng tất cả worker sau khi gặp lỗi
      console.log("Đang dừng tất cả các worker do lỗi...");
      this.workers.forEach(worker => {
        if (worker && worker.isConnected()) {
          worker.kill();
        }
      });
      
      return false;
    }
  }
  
  // Lấy danh sách bài viết mới nhất của mỗi tài khoản
  async _fetchUserPosts(accounts) {
    console.log(`Đang lấy bài viết đầu tiên cho ${accounts.length} tài khoản...`);
    
    const getUserPosts = require("../services/getPostUser");
    const userPosts = {};
    let totalPostsFound = 0;
    let successCount = 0;
    let failureCount = 0;
    let emptyCount = 0;
    
    // Tạo thêm bộ đếm thời gian
    const startTime = Date.now();
    let lastProgressUpdate = startTime;
    
    try {
      // Xử lý song song để tăng tốc quá trình lấy bài viết
      console.log("Bắt đầu lấy bài viết cho tất cả tài khoản (có thể mất vài phút)...");
      
      // === CHỈNH SỬA: GIẢM KHẢ NĂNG BỊ LỖI 429 ===
      // Giảm số lượng tài khoản trong mỗi lô và thêm delay giữa các request
      const BATCH_SIZE = 10; // [CHỈNH SỬA] Giảm từ 20 xuống 10 tài khoản mỗi lô
      const batches = [];
      
      for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
        batches.push(accounts.slice(i, i + BATCH_SIZE));
      }
      
      console.log(`Chia thành ${batches.length} lô, mỗi lô ${BATCH_SIZE} tài khoản (giảm để tránh lỗi 429)`);
      
      // Xử lý từng lô tài khoản
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        
        // === CHỈNH SỬA: Tăng delay giữa các lô để tránh lỗi 429 ===
        if (batchIndex > 0) {
          const batchDelay = 500 + Math.floor(Math.random() * 1100); // 6-10 giây delay giữa các lô
          console.log(`Đợi ${batchDelay/1000} giây trước khi xử lý lô tiếp theo để tránh lỗi 429...`);
          await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
        
        // Thực hiện song song các requests trong lô
        const batchResults = await Promise.allSettled(
          batch.map(async (user, userIndex) => {
            if (!user || !user.uid) {
              console.warn(`Bỏ qua tài khoản không hợp lệ:`, user);
              return { user, error: "Tài khoản không hợp lệ" };
            }
            
            // === CHỈNH SỬA: Tăng delay giữa các request trong lô ===
            // Delay từ 500ms đến 1.5s giữa các request trong cùng lô
            const inBatchDelay = 500 + Math.floor(Math.random() * 1000);
            await new Promise(resolve => setTimeout(resolve, inBatchDelay * userIndex));
            
            try {
              const posts = await getUserPosts(user);
              
              // Chỉ trả về bài đầu tiên nếu có
              if (posts && posts.length > 0) {
                return { 
                  user,
                  posts: [posts[0]] // Chỉ lấy bài đầu tiên
                };
              } else {
                return { user, posts: [] };
              }
            } catch (error) {
              // === CHỈNH SỬA: Xử lý lỗi 429 với thời gian chờ lâu hơn ===
              if (error.response && error.response.status === 429) {
                console.warn(`⚠️ Lỗi 429 (Too Many Requests) khi lấy bài viết cho ${user.piname}. Đợi thêm...`);
                // Đợi thêm 10 giây khi gặp lỗi 429 (tăng từ 5 giây)
                await new Promise(resolve => setTimeout(resolve, 10000));
                try {
                  // Thử lại một lần nữa sau khi đợi
                  const retryPosts = await getUserPosts(user);
                  if (retryPosts && retryPosts.length > 0) {
                    return { 
                      user,
                      posts: [retryPosts[0]]
                    };
                  }
                } catch (retryError) {
                  // Nếu vẫn lỗi 429 sau khi thử lại, đợi thêm 15 giây và thử lần nữa
                  if (retryError.response && retryError.response.status === 429) {
                    console.warn(`⚠️ Vẫn gặp lỗi 429 cho ${user.piname}, đợi thêm 15 giây và thử lại lần cuối...`);
                    await new Promise(resolve => setTimeout(resolve, 15000));
                    try {
                      const finalRetryPosts = await getUserPosts(user);
                      if (finalRetryPosts && finalRetryPosts.length > 0) {
                        return { 
                          user,
                          posts: [finalRetryPosts[0]]
                        };
                      }
                    } catch (finalError) {
                      return { user, error: `Lỗi sau 3 lần thử: ${finalError.message}` };
                    }
                  }
                  return { user, error: `Lỗi khi thử lại: ${retryError.message}` };
                }
              }
              return { user, error: error.message };
            }
          })
        );
        
        // Xử lý kết quả của lô
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            const { user, posts, error } = result.value;
            
            if (error) {
              console.error(`Lỗi khi lấy bài viết của tài khoản ${user?.piname || 'không xác định'}: ${error}`);
              failureCount++;
            } else if (posts && posts.length > 0) {
              userPosts[user.uid] = posts;
              totalPostsFound += posts.length;
              successCount++;
            } else {
              userPosts[user.uid] = [];
              emptyCount++;
            }
          } else {
            console.error(`Lỗi không xử lý được: ${result.reason}`);
            failureCount++;
          }
        }
        
        // Cập nhật tiến độ định kỳ
        const currentTime = Date.now();
        if (currentTime - lastProgressUpdate > 5000) { // Cập nhật mỗi 5 giây
          const progress = Math.round((batchIndex + 1) * 100 / batches.length);
          const elapsed = Math.round((currentTime - startTime) / 1000);
          console.log(`Tiến độ: ${progress}% (${batchIndex + 1}/${batches.length} lô) | Thời gian: ${elapsed}s | Tìm thấy ${successCount} tài khoản có bài viết`);
          lastProgressUpdate = currentTime;
        }
        
        // === CHỈNH SỬA: Thêm nghỉ bổ sung sau mỗi lô để tránh lỗi 429 ===
        if (batchIndex < batches.length - 1) {
          const cooldownDelay = 100 + Math.floor(Math.random() * 500); // 3-5 giây
          console.log(`Đợi thêm ${cooldownDelay/1000} giây trước khi tiếp tục...`);
          await new Promise(resolve => setTimeout(resolve, cooldownDelay));
        }
      }
      
      // Hiển thị thống kê
      const endTime = Date.now();
      const totalTime = Math.round((endTime - startTime) / 1000);
      
      console.log(`\n==== Kết quả lấy bài viết (${totalTime}s) ====`);
      console.log(`✅ Thành công: ${successCount} tài khoản có bài viết`);
      console.log(`⚠️ Không có bài viết: ${emptyCount} tài khoản`);
      console.log(`❌ Lỗi: ${failureCount} tài khoản`);
      console.log(`Tổng số bài viết đã lấy: ${totalPostsFound}`);
      console.log(`=======================================\n`);
      
      if (totalPostsFound === 0) {
        console.warn("⚠️ Không tìm thấy bài viết nào từ tất cả tài khoản! Quá trình sẽ dừng lại.");
      }
      
      return userPosts;
    } catch (error) {
      console.error(`❌ Lỗi không xử lý được khi lấy bài viết: ${error.message}`, error);
      return userPosts; // Trả về bất kỳ bài viết nào đã lấy được
    }
  }
  
  // Cập nhật kết quả like từ worker
  updateLikeResult(workerId, likeResult) {
    if (!likeResult) return;
    
    // Cập nhật thống kê like
    if (!this.results.likeStats) {
      this.results.likeStats = {
        usersCompletedLiking: new Set(), // tài khoản đã hoàn thành nhiệm vụ like
        usersGotLiked: new Map(),       // số lượng like mỗi tài khoản nhận được
        likeDetails: [],                // chi tiết mỗi lượt like
        likedPostsCount: new Map()      // số lượng like cho mỗi bài viết
      };
    }
    
    // Đảm bảo các thuộc tính trong likeStats tồn tại
    if (!this.results.likeStats.usersCompletedLiking) {
      this.results.likeStats.usersCompletedLiking = new Set();
    }
    if (!this.results.likeStats.usersGotLiked) {
      this.results.likeStats.usersGotLiked = new Map();
    }
    if (!this.results.likeStats.likedPostsCount) {
      this.results.likeStats.likedPostsCount = new Map();
    }
    if (!Array.isArray(this.results.likeStats.likeDetails)) {
      this.results.likeStats.likeDetails = [];
    }
    
    // Thêm chi tiết like
    if (likeResult.details) {
      try {
        this.results.likeStats.likeDetails.push(likeResult.details);
        
        // Cập nhật thông tin người like và được like
        const { sourceUid, targetUid, postId } = likeResult.details;
        
        if (likeResult.success) {
          // Cập nhật tài khoản đã hoàn thành like
          this.results.likeStats.usersCompletedLiking.add(sourceUid);
          
          // Cập nhật tài khoản được like
          if (!this.results.likeStats.usersGotLiked.has(targetUid)) {
            this.results.likeStats.usersGotLiked.set(targetUid, 0);
          }
          this.results.likeStats.usersGotLiked.set(
            targetUid, 
            this.results.likeStats.usersGotLiked.get(targetUid) + 1
          );
          
          // Cập nhật số lượng like của bài viết
          if (postId) {
            if (!this.results.likeStats.likedPostsCount.has(postId)) {
              this.results.likeStats.likedPostsCount.set(postId, 0);
            }
            this.results.likeStats.likedPostsCount.set(
              postId,
              this.results.likeStats.likedPostsCount.get(postId) + 1
            );
          }
        }
      } catch (error) {
        console.error('Lỗi khi xử lý kết quả like:', error);
      }
    }
    
    // Gọi phương thức cha để cập nhật tiến trình chung
    super.updateProgress(workerId, {
      success: likeResult.success ? 1 : 0,
      failure: likeResult.success ? 0 : 1,
      completed: 1
    });
  }
  
  // Hiển thị kết quả like chéo khi hoàn thành
  displayLikeResults() {
    if (!this.results.likeStats) return;
    
    const stats = this.results.likeStats;
    
    console.log(`\n============ KẾT QUẢ LIKE CHÉO ============`);
    console.log(`Số tài khoản đã hoàn thành nhiệm vụ like: ${stats.usersCompletedLiking.size}`);
    console.log(`Số tài khoản được like: ${stats.usersGotLiked.size}`);
    console.log(`Số bài viết được like: ${stats.likedPostsCount.size}`);
    console.log(`\n--- Phân bố like nhận được ---`);
    
    let perfectDistribution = true;
    let minLikes = Infinity;
    let maxLikes = 0;
    
    stats.usersGotLiked.forEach((likeCount, uid) => {
      if (likeCount < this.likeCount) {
        console.warn(`⚠️ Tài khoản ${uid} chỉ nhận được ${likeCount}/${this.likeCount} likes`);
        perfectDistribution = false;
      } else if (likeCount > this.likeCount) {
        console.warn(`⚠️ Tài khoản ${uid} nhận được ${likeCount}/${this.likeCount} likes (dư ${likeCount - this.likeCount})`);
        perfectDistribution = false;
      }
      
      minLikes = Math.min(minLikes, likeCount);
      maxLikes = Math.max(maxLikes, likeCount);
    });
    
    if (perfectDistribution) {
      console.log(`✅ Phân bổ hoàn hảo! Tất cả tài khoản đều nhận đúng ${this.likeCount} likes`);
    } else {
      console.log(`⚠️ Phân bổ chưa hoàn hảo. Số like ít nhất: ${minLikes}, nhiều nhất: ${maxLikes}`);
    }
    
    // Hiển thị số lượng like của mỗi bài viết (top 5 bài viết được like nhiều nhất)
    console.log(`\n--- Thống kê các bài viết được like ---`);
    const sortedPosts = [...stats.likedPostsCount.entries()].sort((a, b) => b[1] - a[1]);
    const top5Posts = sortedPosts.slice(0, 5);
    
    if (top5Posts.length > 0) {
      top5Posts.forEach(([postId, count]) => {
        console.log(`Bài viết ${postId}: ${count} likes`);
      });
      
      if (sortedPosts.length > 5) {
        console.log(`... và ${sortedPosts.length - 5} bài viết khác`);
      }
    } else {
      console.log("Không có bài viết nào được like");
    }
    
    console.log(`==========================================\n`);
  }
}

// Hàm thực hiện like chéo với Cluster
async function handleLikeEachOtherWithCluster(req) {
  try {
    // Fix cứng số lượng like mỗi tài khoản là 12
    const likeCount = 12;
    console.log(`>> Yêu cầu like chéo: mỗi tài khoản like ${likeCount} tài khoản khác và được like bởi ${likeCount} tài khoản khác`);
    
    // Kiểm tra xem hiện tại đang ở Master hay Worker
    if (cluster.isPrimary) {
      // Khởi tạo quản lý cluster
      const availableCores = cpus().length;
      console.log(`>> Máy tính có ${availableCores} CPU cores`);
      
      // === VỊ TRÍ 1: ĐIỀU CHỈNH SỐ LƯỢNG WORKER ===
      // [CHỈNH SỬA] Tính số lượng worker dựa trên số core và dự kiến số tài khoản
      // Nên có 1 worker cho mỗi 50-100 tài khoản để tránh lãng phí tài nguyên
      const accountEstimate = 100; // Ước tính số tài khoản (có thể đọc từ Excel trước)
      const workerCount = Math.min(
        Math.max(1, Math.ceil(availableCores / 2)), // Sử dụng tối đa 1/2 số core
        Math.ceil(accountEstimate / 50)  // 1 worker xử lý khoảng 50 tài khoản
      );
      console.log(`>> Khởi tạo ${workerCount} worker processes (tối ưu cho khoảng ${accountEstimate} tài khoản)...`);
      
      // === VỊ TRÍ 2: ĐIỀU CHỈNH MAX_CONCURRENCY ===
      // [CHỈNH SỬA] Giảm giới hạn đồng thời xuống giá trị hợp lý hơn
      // Nên để 20-30 thay vì 50 để tránh quá tải và request bị từ chối
      let maxConcurrency = 20; // [CHỈNH SỬA] Giảm từ 50 xuống 20
      if (process.env.MAX_CONCURRENCY) {
        const parsedValue = parseInt(process.env.MAX_CONCURRENCY, 10);
        if (!isNaN(parsedValue) && parsedValue > 0) {
          maxConcurrency = Math.min(parsedValue, 30); // Giới hạn không quá 30
        }
      }
      
      console.log(`>> Giới hạn đồng thời: ${maxConcurrency} tác vụ`);
      
      // === THÊM MỚI: Cảnh báo về rate limits và lỗi 429 ===
      console.log("\n⚠️ CHÚ Ý: ĐÃ ĐIỀU CHỈNH CHẬM LIKE XUỐNG ⚠️");
      console.log("Hệ thống đã được cấu hình để CHẬM LẠI, tránh lỗi 429 (Too Many Requests)");
      console.log("Tiến trình sẽ chạy chậm hơn trước, nhưng ổn định hơn và tránh bị block request");
      console.log("Mỗi lượt like sẽ có delay 3-5 giây trước và 1.5-3 giây sau để tránh bị chặn");
      console.log("Các nhóm nhiệm vụ sẽ được xử lý lần lượt với 5-8 giây nghỉ giữa các nhóm\n");
      
      // Khởi tạo manager cho like chéo
      const likeManager = new LikeEachOtherManager({ 
        numWorkers: workerCount,
        concurrencyLimit: maxConcurrency,
        likeCount: likeCount // Fix cứng likeCount là 12
      });
      
      // Lưu tham chiếu vào biến global
      if (typeof global.activeClusterManager !== 'undefined') {
        global.activeClusterManager = likeManager;
      }
      
      // Theo dõi quá trình xử lý để đảm bảo không bị kẹt
      let lastProgress = 0;
      let stuckCounter = 0;
      
      // Thiết lập biến để theo dõi trạng thái
      let isProcessingComplete = false;
      let timeoutTriggered = false;
      let processTimeout = null;
      
      // === VỊ TRÍ 3: CƠ CHẾ PHÁT HIỆN TIẾN TRÌNH KẸT ===
      // [CHỈNH SỬA] Theo dõi tiến trình để phát hiện khi bị kẹt và dừng
      const progressMonitor = setInterval(() => {
        const currentProgress = likeManager.results.completed || 0;
        const totalTasks = likeManager.results.total || 0;
        
        // [THÊM MỚI] Kiểm tra nếu tất cả nhiệm vụ đã hoàn thành
        if (totalTasks > 0 && currentProgress >= totalTasks && !isProcessingComplete) {
          console.log(`✅ Đã hoàn thành tất cả ${totalTasks} nhiệm vụ. Kết thúc tiến trình.`);
          clearInterval(progressMonitor);
          
          if (!isProcessingComplete) {
            isProcessingComplete = true;
            // Kích hoạt sự kiện hoàn thành
            likeManager.emit('complete', {
              ...likeManager.results,
              message: "Tất cả nhiệm vụ đã hoàn thành"
            });
          }
          return;
        }
        
        // Kiểm tra tiến trình bị kẹt
        if (currentProgress === lastProgress && currentProgress > 0) {
          stuckCounter++;
          if (stuckCounter >= 4) { // Giảm từ 5 xuống 4 lần kiểm tra liên tiếp (20 giây)
            console.warn(`⚠️ Phát hiện tiến trình có thể bị kẹt! Không có tiến triển mới trong ${stuckCounter * 5} giây.`);
            if (stuckCounter >= 8) { // Giảm từ 12 xuống 8 (40 giây không có tiến triển)
              console.error(`❌ Tiến trình bị kẹt quá lâu, bắt đầu kết thúc...`);
              clearInterval(progressMonitor);
              
              if (!isProcessingComplete && !timeoutTriggered) {
                timeoutTriggered = true;
                likeManager.displayLikeResults();
                
                // Dừng các worker
                console.log("Đang dừng tất cả các worker do tiến trình bị kẹt...");
                likeManager.workers.forEach(worker => {
                  if (worker && worker.isConnected()) {
                    worker.kill();
                  }
                });
                
                // Kích hoạt complete event để kết thúc quá trình
                likeManager.emit('complete', {
                  ...likeManager.results,
                  message: "Tiến trình bị dừng do kẹt quá lâu"
                });
              }
            }
          }
        } else {
          lastProgress = currentProgress;
          stuckCounter = 0;
        }
      }, 5000); // Kiểm tra mỗi 5 giây
      
      // Sự kiện hoàn thành
      likeManager.on('complete', (results) => {
        isProcessingComplete = true;
        clearInterval(progressMonitor);
        if (processTimeout) {
          clearTimeout(processTimeout);
        }
        
        console.log(`\n>> Kết quả cuối cùng: ${results.success || 0} like thành công, ${results.failure || 0} like thất bại`);
        likeManager.displayLikeResults();
        
        // [THÊM MỚI] Đảm bảo tất cả worker đều dừng sau khi hoàn thành
        console.log("Đang dừng tất cả các worker sau khi hoàn thành...");
        likeManager.workers.forEach(worker => {
          if (worker && worker.isConnected()) {
            worker.kill();
          }
        });
      });

      likeManager.on('error', (error) => {
        console.error(`>> Lỗi từ LikeEachOtherManager: ${error.message}`);
      });
      
      try {
        // Khởi tạo cluster
        const isMaster = await likeManager.initialize();
        
        if (isMaster) {
          console.log(">> Bắt đầu phân bổ nhiệm vụ like chéo...");
          
          // === VỊ TRÍ 4: THIẾT LẬP TIMEOUT ===
          // [CHỈNH SỬA] Thiết lập timeout tổng thể từ 10 lên 15 phút do đã làm chậm quá trình
          const timeoutMinutes = 15;
          console.log(`⏱️ Thiết lập thời gian tối đa cho quá trình: ${timeoutMinutes} phút`);
          processTimeout = setTimeout(() => {
            if (!isProcessingComplete) {
              timeoutTriggered = true;
              console.warn(`⚠️ Đã hết thời gian thực hiện (${timeoutMinutes} phút). Bắt đầu dừng tiến trình...`);
              
              // Hiển thị kết quả dù chưa hoàn thành
              likeManager.displayLikeResults();
              
              // Dừng các worker
              console.log("Đang dừng tất cả các worker do hết thời gian...");
              likeManager.workers.forEach(worker => {
                if (worker && worker.isConnected()) {
                  worker.kill();
                }
              });
              
              // Báo hiệu hoàn thành
              likeManager.emit('complete', {
                ...likeManager.results,
                message: `Đã hết thời gian thực hiện (${timeoutMinutes} phút)`
              });
            }
          }, 1000 * 60 * timeoutMinutes);
          
          // Phân bổ tài khoản và nhiệm vụ like cho các worker
          const success = await likeManager.distributeLikeAssignments();
          
          if (!success) {
            clearInterval(progressMonitor);
            if (processTimeout) clearTimeout(processTimeout);
            
            // [THÊM MỚI] Đảm bảo dừng tất cả worker khi không thành công
            console.log("Đang dừng tất cả các worker do không thể phân bổ nhiệm vụ...");
            likeManager.workers.forEach(worker => {
              if (worker && worker.isConnected()) {
                worker.kill();
              }
            });
            
            return {
              success: false,
              message: "Không thể phân bổ nhiệm vụ like chéo!"
            };
          }
          
          // Đợi tất cả worker hoàn thành
          return new Promise((resolve) => {
            // Thêm listener cho sự kiện 'complete'
            likeManager.on('complete', (results) => {
              clearInterval(progressMonitor);
              if (processTimeout) clearTimeout(processTimeout);
              
              resolve({
                success: true,
                message: `Đã hoàn thành ${results.success || 0}/${results.total || 0} like chéo thành công!`,
                stats: {
                  ...results,
                  likeCount: likeCount
                }
              });
            });
          });
        }
      } catch (error) {
        console.error(`Lỗi khi khởi tạo hoặc phân phối nhiệm vụ: ${error.message}`);
        
        if (progressMonitor) clearInterval(progressMonitor);
        if (processTimeout) clearTimeout(processTimeout);
        
        return {
          success: false,
          message: `Lỗi khi khởi tạo hoặc phân phối nhiệm vụ: ${error.message}`,
          error: error.toString()
        };
      }
    }
    
    // Nếu đang ở worker process, không làm gì cả vì worker sẽ được quản lý bởi worker-processor.js
    return { 
      success: true,
      message: "Đã khởi động các worker processes để like chéo"
    };
  } catch (error) {
    console.error(`❌ Lỗi không xử lý được: ${error.message}`);
    return {
      success: false,
      message: `Đã xảy ra lỗi khi like chéo: ${error.message}`,
      error: error.toString()
    };
  }
}

module.exports = handleLikeEachOtherWithCluster; 