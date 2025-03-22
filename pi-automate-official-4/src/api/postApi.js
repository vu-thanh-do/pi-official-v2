const apiClient = require('./apiClient');

async function postArticle(proxy, user, title, content) {
    const client = apiClient(proxy, user);
    
    try {
        const response = await client.post('', {
            component: 'article',
            action: 'create',
            title: title,
            content: content,
            user_name: user.piname,
            gallery: 'https://asset.vcity.app/vfile/demo.jpg',
            selected_country: 1,
            selected_chain: 0
        });

        return response.data;
    } catch (error) {
        console.error(`❌ [${user.piname}] Lỗi đăng bài:`, error.message);
        return null;
    }
}

module.exports = { postArticle };
