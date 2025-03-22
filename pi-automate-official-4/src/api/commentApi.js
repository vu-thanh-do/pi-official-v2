const apiClient = require('./apiClient');

async function commentArticle(proxy, user, articleId, comment) {
    const client = apiClient(proxy, user);

    try {
        await client.post('', {
            action: 'send',
            component: 'comment',
            message: comment,
            user_name: user.piname,
            article_id: articleId,
            selected_country: 1,
            selected_chain: 0
        });

        console.log(`💬 [${user.piname}] Bình luận: "${comment}" vào bài ${articleId}`);
    } catch (error) {
        console.error(`❌ [${user.piname}] Lỗi Bình luận:`, error.message);
    }
}

module.exports = { commentArticle };
