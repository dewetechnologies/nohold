const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const {
  uploadVideo,
  getVideo,
  deleteVideo
} = require('../controllers/videoController');

// Upload a video
router.post('/upload', upload.single('video'), uploadVideo);

// Get a specific video
router.get('/:id', getVideo);

// Delete a video
router.delete('/:id', deleteVideo);

module.exports = router;