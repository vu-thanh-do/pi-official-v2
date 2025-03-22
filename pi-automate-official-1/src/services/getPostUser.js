const axios = require("axios");

async function getUserPosts(user) {
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
        'user-agent': user.userAgent,
        'x-requested-with': 'XMLHttpRequest'
      },
      data: `action=SPEAKER-INFO&component=speaker&speaker_id=${user.uid}&vid=${user.uid}&english_version=0&selected_country=1&selected_chain=0`
    });

    if (response.data && response.data.article) {
      return response.data.article.map(article => article.id);
    }
    return [];
  } catch (error) {
    console.error(`Lỗi khi lấy bài viết của user ${user.piname}:`, error.message);
    return [];
  }
}

module.exports = getUserPosts;