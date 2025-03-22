const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const configPath = path.join(__dirname, '../config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
const apiClient = (user) => {
    console.log(`>> Tạo API client cho user: ${user.piname}`);
    const proxyUrl = `http://${user.proxy.name}:${user.proxy.password}@${user.proxy.host}:${user.proxy.port}`;
    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    
    const axiosInstance = axios.create({
        baseURL: 'https://pivoice.app',
        httpsAgent,
        timeout: 20000,
        maxContentLength: 5 * 1024 * 1024,
        maxBodyLength: 5 * 1024 * 1024,
        maxRedirects: 5,
        headers: {
            'Accept': '*/*',
            'Accept-Language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `uid=${user.uid}; ukey=${user.ukey}; piname=${user.piname}`,
            'User-Agent': user.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Origin': 'https://pivoice.app',
            'Referer': 'https://pivoice.app/',
            'X-Requested-With': 'XMLHttpRequest',
            'Priority': 'u=1, i',
            'Sec-Ch-Ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        }
    });
    axiosInstance.interceptors.request.use(config => {
        config.requestId = `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        console.log(`>> [${config.requestId}] Gọi API: ${config.baseURL}${config.url || ''}`);
        console.log(`>> [${config.requestId}] Data: ${config.data || 'Không có'}`);
        let curlCommand = `curl '${config.baseURL}${config.url || ''}' \\\n`;
        Object.entries(config.headers).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'common' && value !== undefined) {
                curlCommand += `  -H '${key}: ${value}' \\\n`;
            }
        });
        if (config.data) {
            curlCommand += `  --data-raw '${config.data}'`;
        }
        return config;
    }, error => {
        console.error(`❌ Lỗi khi gửi request: ${error.message}`);
        return Promise.reject(error);
    });

    axiosInstance.interceptors.response.use(response => {
        if (response.config && response.config.requestId) {
            console.log(`>> [${response.config.requestId}] Nhận response thành công, status: ${response.status}`);
        }
        return response;
    }, error => {
        if (error.config && error.config.requestId) {
            const requestId = error.config.requestId;
            if (error.code === 'ECONNABORTED') {
                console.error(`❌ [${requestId}] Request timeout sau ${error.config.timeout}ms: ${error.message}`);
            } else if (error.response) {
                console.error(`❌ [${requestId}] Lỗi HTTP ${error.response.status}: ${error.message}`);
            } else {
                console.error(`❌ [${requestId}] Lỗi mạng: ${error.message}`);
            }
        }
        return Promise.reject(error);
    });
    
    return axiosInstance;
};

module.exports = apiClient;
