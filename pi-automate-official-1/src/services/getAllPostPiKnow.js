const axios = require("axios");

async function getAllPostPiKnow(user) {
  console.log(`>> Đang lấy article ID từ trang chủ PiKnow cho user ${user.piname}`);

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
        'user-agent': user.userAgent,
        'x-requested-with': 'XMLHttpRequest'
      },
      data: `component=know&action=get-list&search=&user_name=${user.piname}&english_version=0&selected_country=1&selected_chain=0`
    });
    if (
      response.data &&
      response.data.data &&
      response.data.data.status === 1 &&
      Array.isArray(response.data.data.data)
    ) {
      const ids = response.data.data.data.map(item => item.id);
      console.log(`✅ Đã lấy được ${ids.length} bài PiKnow cho user ${user.piname}`);
      return ids;
    }
    console.log(`⚠️ Không tìm thấy bài PiKnow nào cho user ${user.piname}`);
    return [];
  } catch (error) {
    console.error(`❌ Lỗi khi lấy post PiKnow cho user ${user.piname}:`, error.message);
    if (error.response) {
      console.error(`Mã lỗi: ${error.response.status}`);
      console.error(`URL gọi: ${error.config?.url}`);
      console.error(`URL đầy đủ: ${error.config?.baseURL}${error.config?.url}`);
      console.error(`Phương thức: ${error.config?.method.toUpperCase()}`);
    }
    return [];
  }
}

module.exports = getAllPostPiKnow;
