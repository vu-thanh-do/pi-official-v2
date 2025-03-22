const cluster = require('cluster');
const express = require('express');
const bodyParser = require('body-parser');
const { handleComment } = require('./controllers/comments');
const { handleLike } = require('./controllers/like');
const { handlePostArticles } = require('./controllers/posts');
const handleDelete = require('./controllers/delete');
const { handlePiKnow } = require('./controllers/piKnow');
const handleLikeEachOther = require('./controllers/likeEachOther');
const handleLogin = require('./controllers/login');
const { startRotation, stopRotation, rotationProgress } = require('./controllers/rotation');

// Đối tượng để lưu kết quả tổng hợp
let results = {
  total: 0,
  completed: 0,
  success: 0, 
  failure: 0
};

function startServer(port) {
  // Khởi tạo Express server
  const server = express();
  server.use(bodyParser.json());

  // Xử lý API
  server.post('/execute-tasks', async (req, res) => {
    try {
      console.log('Bắt đầu thực hiện các tác vụ...');
      const { commentCount, likeCount, deleteCount, postCount, piKnow, likeEachOther, login } = req.body;
      let tasks = [];

      if (login > 0) {
        console.log(`Thực hiện đăng nhập ${login} tài khoản...`);
        tasks.push(handleLogin(login));
      }
      if (commentCount > 0) {
        console.log(`Thực hiện comment ${commentCount} lần...`);
        tasks.push(handleComment(commentCount));
      }
      if (likeCount > 0) {
        console.log(`Thực hiện like ${likeCount} lần...`);
        tasks.push(handleLike(likeCount));
      }
      if (deleteCount > 0) {
        console.log(`Thực hiện xóa ${deleteCount} bài...`);
        tasks.push(handleDelete(deleteCount));
      }
      if (postCount > 0) {
        console.log(`Thực hiện đăng ${postCount} bài...`);
        tasks.push(handlePostArticles(postCount));
      }
      if (piKnow > 0) {
        console.log(`Thực hiện comment PiKnow ${piKnow} lần...`);
        tasks.push(handlePiKnow(piKnow));
      }
      if (likeEachOther > 0) {
        console.log(`Thực hiện like chéo ${likeEachOther} lần...`);
        tasks.push(handleLikeEachOther(likeEachOther));
      }

      const results = await Promise.allSettled(tasks);
      const successCount = results.filter(r => r.status === "fulfilled").length;
      const failCount = results.filter(r => r.status === "rejected").length;

      res.json({
        success: true,
        message: `Hoàn thành ${successCount} tác vụ, ${failCount} thất bại.`,
        details: results
      });
    } catch (error) {
      console.error('Lỗi:', error.message);
      res.json({ success: false, message: "Lỗi khi chạy tác vụ.", error: error.message });
    }
  });

  // Routes cho chế độ luân phiên
  server.post('/start-rotation', startRotation);
  server.post('/stop-rotation', stopRotation);
  server.get('/rotation-progress', rotationProgress);

  // Thêm route trạng thái cho cluster
  server.get('/cluster-status', (req, res) => {
    res.json({
      success: true,
      results: results,
      isMaster: cluster.isPrimary,
      workers: Object.keys(cluster.workers || {}).length,
      pid: process.pid
    });
  });

  // Khởi động server Express
  server.listen(port, () => {
    console.log(`Server đang chạy tại port ${port} (PID: ${process.pid})`);
  });

  return server;
}

// Chỉ xuất ra hàm startServer
module.exports = { startServer }; 