const concurrently = require('concurrently');
const fs = require('fs');

// Đọc số lượng thư mục dự án
const directories = fs.readdirSync('.').filter(dir => dir.startsWith('pi-automate-official-'));

// Tạo mảng lệnh chạy cho từng dự án
const commands = directories.map((dir, index) => ({
    command: `cd ${dir} && npm start`,
    name: dir,
    prefixColor: `bgBlue.bold`
}));

// Chạy đồng thời tất cả các dự án
const { result } = concurrently(commands, {
    prefix: 'name',
    killOthers: ['failure', 'success'],
    restartTries: 3,
});

// Sử dụng event listeners thay vì .then()
result.catch(error => {
    console.error('Có lỗi xảy ra:', error);
}); 