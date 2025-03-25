 const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Dịch vụ xoay proxy để tránh lỗi 429
 * Mỗi key có thể xoay 1 lần mỗi giây
 */
class ProxyRotationService {
  constructor() {
    // Đường dẫn tới file chứa danh sách key
    this.keyFilePath = path.join(__dirname, '../data/keyxoay.txt');
    
    // Map lưu trữ proxy cho mỗi key và thời gian có thể dùng lại
    this.proxyCache = new Map();
    
    // Map lưu trữ thời gian có thể xoay tiếp theo cho mỗi key
    this.nextRotationTime = new Map();
    
    // Đọc danh sách key từ file
    this.keys = this._readKeysFromFile();
    
    console.log(`Đã tải ${this.keys.length} key proxy xoay`);
    
    // Map lưu trữ đang sử dụng proxy nào cho user nào
    this.userProxyMap = new Map();
    
    // Khởi tạo cache proxy cho mỗi key
    this._initializeProxyCache();
  }
  
  /**
   * Đọc danh sách key từ file
   */
  _readKeysFromFile() {
    try {
      if (fs.existsSync(this.keyFilePath)) {
        const keysContent = fs.readFileSync(this.keyFilePath, 'utf8');
        return keysContent.split('\n').filter(key => key.trim().length > 0);
      }
      console.error('Không tìm thấy file key xoay!');
      return [];
    } catch (error) {
      console.error('Lỗi khi đọc file key xoay:', error.message);
      return [];
    }
  }
  
  /**
   * Khởi tạo cache proxy cho mỗi key
   */
  async _initializeProxyCache() {
    if (this.keys.length === 0) {
      console.error('Không có key nào để khởi tạo proxy!');
      return;
    }
    
    console.log('Đang khởi tạo proxy cho tất cả các key...');
    
    // Lấy proxy cho tất cả các key
    const initProxyPromises = this.keys.map(async (key, index) => {
      try {
        // Thêm delay 100ms giữa các request để tránh quá tải API
        await new Promise(resolve => setTimeout(resolve, index * 100));
        
        const proxy = await this._fetchProxyWithKey(key);
        if (proxy) {
          console.log(`Key ${index + 1}: Lấy được proxy ${proxy.host}:${proxy.port}`);
        }
      } catch (error) {
        console.error(`Lỗi khi khởi tạo proxy cho key ${key}:`, error.message);
      }
    });
    
    await Promise.all(initProxyPromises);
    console.log('Đã khởi tạo xong proxy cho tất cả các key khả dụng');
  }
  
  /**
   * Lấy proxy mới cho key xác định
   */
  async _fetchProxyWithKey(key, nhaMang = 'fpt') {
    try {
      // Kiểm tra nếu key có thể xoay tiếp
      const now = Date.now();
      if (this.nextRotationTime.has(key) && now < this.nextRotationTime.get(key)) {
        const waitTime = Math.ceil((this.nextRotationTime.get(key) - now) / 1000);
        console.log(`Key ${key} phải đợi ${waitTime}s nữa mới có thể xoay proxy`);
        
        // Trả về proxy đang cache nếu còn hợp lệ
        if (this.proxyCache.has(key) && this.proxyCache.get(key).expireTime > now) {
          return this.proxyCache.get(key);
        }
        
        // Nếu không có proxy trong cache, phải đợi
        return null;
      }
      
      // Gọi API để lấy proxy mới
      const response = await axios.get(`https://proxyxoay.shop/api/get.php?key=${key}&nhamang=${nhaMang}`, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000
      });
      
      if (response.data.status === 100) {
        // Proxy mới lấy được
        const proxyData = response.data.proxyhttp.split(':');
        const expiresIn = parseInt(response.data.message.match(/(\d+)s/)[1]) * 1000;
        
        const proxy = {
          host: proxyData[0],
          port: proxyData[1],
          name: proxyData[2],
          password: proxyData[3],
          expireTime: Date.now() + expiresIn,
          key: key
        };
        
        // Lưu vào cache
        this.proxyCache.set(key, proxy);
        
        // Cho phép xoay tiếp sau 1 giây (1000ms)
        this.nextRotationTime.set(key, Date.now() + 1000);
        
        return proxy;
      } else if (response.data.status === 101) {
        // Cần đợi để xoay tiếp
        const waitSeconds = parseInt(response.data.message.match(/(\d+)s/)[1]);
        console.log(`Key ${key} cần đợi ${waitSeconds}s nữa mới có thể xoay proxy`);
        
        // Cập nhật thời gian có thể xoay tiếp
        this.nextRotationTime.set(key, Date.now() + (waitSeconds * 1000));
        
        // Trả về proxy đang cache nếu còn hợp lệ
        if (this.proxyCache.has(key) && this.proxyCache.get(key).expireTime > Date.now()) {
          return this.proxyCache.get(key);
        }
        
        return null;
      } else {
        console.error(`Lỗi không xác định khi xoay proxy với key ${key}:`, response.data);
        return null;
      }
    } catch (error) {
      console.error(`Lỗi khi lấy proxy với key ${key}:`, error.message);
      return null;
    }
  }
  
  /**
   * Lấy proxy từ pool cho một user
   * Nếu user đã có proxy và proxy còn hợp lệ, trả về proxy đó
   * Nếu không, lấy proxy mới cho user
   */
  async getProxyForUser(userId) {
    // Kiểm tra nếu user đã có proxy và proxy còn hợp lệ
    if (this.userProxyMap.has(userId)) {
      const currentProxy = this.userProxyMap.get(userId);
      const key = currentProxy.key;
      
      // Kiểm tra xem proxy còn hợp lệ không
      if (this.proxyCache.has(key) && this.proxyCache.get(key).expireTime > Date.now()) {
        return this.proxyCache.get(key);
      }
      
      // Nếu proxy không còn hợp lệ, thử xoay proxy mới với key hiện tại
      const newProxy = await this._fetchProxyWithKey(key);
      if (newProxy) {
        this.userProxyMap.set(userId, newProxy);
        return newProxy;
      }
    }
    
    // Lấy key chưa được sử dụng hoặc key ít được sử dụng nhất
    const keyUsageCount = new Map();
    this.keys.forEach(key => keyUsageCount.set(key, 0));
    
    // Đếm số lượng user đang sử dụng mỗi key
    for (const proxy of this.userProxyMap.values()) {
      if (keyUsageCount.has(proxy.key)) {
        keyUsageCount.set(proxy.key, keyUsageCount.get(proxy.key) + 1);
      }
    }
    
    // Sắp xếp key theo số lượng sử dụng tăng dần
    const sortedKeys = [...keyUsageCount.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(entry => entry[0]);
    
    // Thử lấy proxy với từng key cho đến khi thành công
    for (const key of sortedKeys) {
      const proxy = await this._fetchProxyWithKey(key);
      if (proxy) {
        this.userProxyMap.set(userId, proxy);
        return proxy;
      }
    }
    
    console.error(`Không thể lấy proxy cho user ${userId} - tất cả key đều đang bị hạn chế!`);
    return null;
  }
  
  /**
   * Lấy proxy mới cho user, bắt buộc xoay mới
   */
  async rotateProxyForUser(userId) {
    // Xóa proxy hiện tại của user
    this.userProxyMap.delete(userId);
    
    // Lấy proxy mới
    return this.getProxyForUser(userId);
  }
  
  /**
   * Xoay tất cả proxy hiện tại
   */
  async rotateAllProxies() {
    console.log('Đang xoay tất cả proxy...');
    
    // Xóa tất cả map proxy của user
    this.userProxyMap.clear();
    
    // Khởi tạo lại cache proxy
    await this._initializeProxyCache();
    
    console.log('Đã xoay xong tất cả proxy');
  }
}

// Tạo và export instance duy nhất
const proxyRotationService = new ProxyRotationService();

module.exports = proxyRotationService;