const express = require('express');
const bodyParser = require('body-parser');
const { handleComment } = require('./controllers/comments');
const { handleLike } = require('./controllers/like');
// const { handleDelete } = require('./controllers/delete');
const {  handlePostArticles } = require('./controllers/posts');
const path = require('path');
const handleDelete = require('./controllers/delete');
const { handlePiKnow } = require('./controllers/piKnow');
const handleLikeEachOther = require('./controllers/likeEachOther');
const handleLogin = require('./controllers/login');

const app = express();
app.use(express.static('public'));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(bodyParser.json());

app.get('/', (req, res) => res.render('index'));

app.post('/execute-tasks', async (req, res) => {
    try {
        const { commentCount, likeCount,deleteCount, postCount, piKnow, likeEachOther, login } = req.body;
        let tasks = [];
        console.log(commentCount, likeCount, postCount)
        if (commentCount > 0) tasks.push(handleComment(commentCount));
        if (likeCount > 0) tasks.push(handleLike(likeCount));
         if (deleteCount > 0) tasks.push(handleDelete(deleteCount));
        if (postCount > 0) tasks.push(handlePostArticles(postCount));
        if (piKnow > 0) tasks.push(handlePiKnow(piKnow));
        if (likeEachOther > 0) tasks.push(handleLikeEachOther(likeEachOther));
        if (login > 0) tasks.push(handleLogin(login));
        const results = await Promise.allSettled(tasks);
        console.log(results)
        const successCount = results.filter(r => r.status === "fulfilled").length;
        const failCount = results.filter(r => r.status === "rejected").length;

        res.json({
            success: true,
            message: `Hoàn thành ${successCount} tác vụ, ${failCount} thất bại.`,
            details: results
        });
    } catch (error) {
        console.log(error.message)
        res.json({ success: false, message: "Lỗi khi chạy tác vụ.", error });
    }
});

app.listen(3000, () => console.log("🚀 Server chạy tại http://localhost:3000"));
