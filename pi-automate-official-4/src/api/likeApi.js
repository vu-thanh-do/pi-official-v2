const apiClient = require('./apiClient');

async function likeArticle(proxy, user, articleId) {
    const client = apiClient(proxy, user);

    try {
        await client.post('', {
            component: 'article',
            action: 'like',
            aid: articleId,
            user_name: user.piname,
            selected_country: 1,
            selected_chain: 0
        });
        console.log(`👍 [${user.piname}] Đã Like bài viết ${articleId}`);
    } catch (error) {
        console.error(`❌ [${user.piname}] Lỗi Like bài viết:`, error.message);
    }
}

module.exports = { likeArticle };
