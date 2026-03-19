const express = require("express");
const router = express.Router();
const multer = require("multer");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const r2Client = require("../config/r2");
const { v4: uuidv4 } = require("uuid");
const auth = require("../middleware/auth.middleware");

// All routes require authentication
router.use(auth);

// Memory storage for multer (stream to R2)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// POST /api/calls/voice-message - Upload voice message to R2
router.post("/voice-message", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const fileExtension = req.file.mimetype === "audio/webm" ? "webm" : "ogg";
    const fileName = `voice-messages/${uuidv4()}.${fileExtension}`;

    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const url = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({
      url,
      publicId: fileName,
      size: req.file.size,
      resourceType: "audio",
      format: fileExtension,
      name: `voice-message.${fileExtension}`,
    });
  } catch (error) {
    console.error("Voice message upload error:", error);
    res.status(500).json({ error: "Failed to upload voice message" });
  }
});

module.exports = router;
