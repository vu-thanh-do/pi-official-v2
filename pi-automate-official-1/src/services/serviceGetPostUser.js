const axios = require('axios');

/**
 * Lấy danh sách các id bài đăng của user
 * @param {Object} user - Thông tin user (uid, ukey, piname, userAgent tùy chọn)
 * @returns {Promise<Array<number>>} - Mảng chứa id của các bài đăng
 */
async function getAllPostIds(user) {
  try {
    const response = await axios({
      url: 'https://pivoice.app/api',
      method: 'post',
      headers: {
        'accept': '*/*',
        'accept-language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'cookie': `uid=${user.uid}; ukey=${user.ukey}; piname=${user.piname}`,
        'origin': 'https://pivoice.app',
        'priority': 'u=1, i',
        'referer': 'https://pivoice.app/',
        'sec-ch-ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': user.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'x-requested-with': 'XMLHttpRequest'
      },
      data: `action=SPEAKER-INFO&component=speaker&speaker_id=${user.uid}&vid=${user.uid}&english_version=0&selected_country=1&selected_chain=0`
    });
    
    if (response.data && response.data.article && Array.isArray(response.data.article)) {
      return response.data.article.map(post => post.id);
    }
    return [];
  } catch (error) {
    console.error('Lỗi khi lấy bài đăng:', error);
    return [];
  }
}

/**
 * Xóa bài đăng dựa vào id (aid)
 * @param {Object} user - Thông tin user (uid, ukey, piname, userAgent tùy chọn)
 * @param {number} aid - Id của bài đăng cần xóa
 * @returns {Promise<Object|null>} - Kết quả trả về từ API hoặc null nếu có lỗi
 */
async function deletePostById(user, aid) {
  try {
    const response = await axios({
      url: 'https://pivoice.app/vapi',
      method: 'post',
      headers: {
        'accept': '*/*',
        'accept-language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'cookie': `uid=${user.uid}; ukey=${user.ukey}; piname=${user.piname}`,
        'origin': 'https://pivoice.app',
        'priority': 'u=1, i',
        'referer': 'https://pivoice.app/',
        'sec-ch-ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': user.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'x-requested-with': 'XMLHttpRequest'
      },
      data: `component=article&action=delete&uid=${user.uid}&aid=${aid}&user_name=${user.piname}&english_version=0&selected_country=1&selected_chain=0`
    });
    return response.data;
  } catch (error) {
    console.error(`Lỗi khi xóa bài đăng ${aid}:`, error);
    return null;
  }
}
module.exports = {
  getAllPostIds,
  deletePostById
};
