const apiClient = require("../api/apiClient");
const qs = require("qs");

/**
 * Thực hiện like một bài viết
 * @param {Object} user - Thông tin tài khoản user 
 * @param {String} postId - ID của bài viết cần like
 * @returns {Promise<Object>} - Kết quả thao tác like
 */
async function likePost(user, postId) {
  try {
    console.log(`>> Bắt đầu like bài ${postId} bởi ${user.piname}`);
    
    const maxRetries = 2;
    let retryCount = 0;
    
    while (retryCount <= maxRetries) {
      try {
        if (retryCount > 0) {
          console.log(`>> Thử lại lần ${retryCount}/${maxRetries} cho like bài ${postId}`);
          await sleep(3000 * retryCount);
        }

        const api = apiClient(user);
        const payload = qs.stringify({
          component: "article",
          action: "like",
          aid: postId,
          user_name: user.piname,
          english_version: 0,
          selected_country: 1,
          selected_chain: 0,
        });

        const response = await api.post('/vapi', payload);
        
        if (response.data && response.data.time) {
          console.log(`✅ Đã like thành công bài ${postId} bởi ${user.piname}`);
          return { success: true, postId, userId: user.uid };
        } else {
          console.log(`⚠️ Like bài ${postId} không thành công:`, response.data);
          return { success: false, postId, userId: user.uid };
        }
      } catch (error) {
        console.error(`❌ Lỗi khi like bài ${postId} bởi ${user.piname}:`, error.message);
        
        if (error.response) {
          console.error(`Mã lỗi: ${error.response.status}`);
          
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
        
        return { success: false, postId, userId: user.uid };
      }
    }
    
    return { success: false, postId, userId: user.uid };
  } catch (error) {
    console.error(`Lỗi không xử lý được: ${error.message}`);
    return { success: false, postId, userId: user.uid, error: error.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = likePost; 