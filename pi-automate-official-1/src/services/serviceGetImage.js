const axios = require("axios");

async function getImageUrl() {
  try {
    const response = await axios({
      url: "https://pivoice.app/vapi",
      method: "post",
      headers: {
        accept: "*/*",
        "accept-language":
          "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie:
          "uid=1897311; ukey=B6NRXYXA2Y3YUAF7M3HG2A7NXKRB6H; piname=mm_1740056166961",
        origin: "https://pivoice.app",
        priority: "u=1, i",
        referer: "https://pivoice.app/",
        "sec-ch-ua":
          '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "x-requested-with": "XMLHttpRequest",
      },
      data: "user_name=mm_1740056166961&component=upload&action=list&english_version=0&selected_country=1&selected_chain=0",
    });

    if (
      response.data &&
      response.data.data &&
      response.data.data.status === 1
    ) {
      const images = response.data.data.list;
      if (Array.isArray(images) && images.length > 0) {
        const randomIndex = Math.floor(Math.random() * images.length);
        return "https://asset.vcity.app" + images[randomIndex].url;
      }
    }
    return "https://asset.vcity.app/vfile/2024/11/13/17/1731547067893529571327216841855.jpg";
  } catch (error) {
    console.error("Lỗi khi lấy ảnh:", error);
    return "https://asset.vcity.app/vfile/2024/11/13/17/1731547067893529571327216841855.jpg";
  }
}

module.exports = getImageUrl;
