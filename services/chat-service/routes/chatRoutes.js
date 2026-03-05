const express = require('express');
const {
    startDmConversation,
    listConversations,
    getConversationMessages,
    sendMessage,
    markConversationRead,
} = require('../controllers/chatController');
const { authenticateRequest } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateRequest);

router.post('/conversations/dm', startDmConversation);
router.get('/conversations', listConversations);
router.get('/conversations/:id/messages', getConversationMessages);
router.post('/conversations/:id/messages', sendMessage);
router.post('/conversations/:id/read', markConversationRead);

module.exports = router;
