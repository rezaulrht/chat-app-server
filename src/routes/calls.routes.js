const express = require("express");
const router = express.Router();
const multer = require("multer");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const r2Client = require("../config/r2");
const { v4: uuidv4 } = require("uuid");
const auth = require("../middleware/auth.middleware");
const { generateLiveKitToken } = require("../utils/livekit");
const CallLog = require("../models/CallLog");
const Conversation = require("../models/Conversation");
const User = require("../models/User");

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

// POST /api/calls/token - Generate LiveKit access token
router.post("/token", async (req, res) => {
  try {
    const { roomName, callType } = req.body;

    if (!roomName) {
      return res.status(400).json({ error: "roomName required" });
    }

    const user = await User.findById(req.user.id).select("name avatar");
    // Identity must be unique per room — use userId so two users with same name don't collide
    const identity = req.user.id;

    console.log(`[LiveKit token] room=${roomName} identity=${identity} name=${user?.name}`);
    const token = await generateLiveKitToken(roomName, identity, { callType, name: user?.name, avatar: user?.avatar || "" });

    res.json({ token, url: process.env.LIVEKIT_URL });
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// POST /api/calls/initiate - Create CallLog + emit call:incoming via socket
router.post("/initiate", async (req, res) => {
  try {
    const { conversationId, callType } = req.body;
    const initiatorId = req.user.id;

    if (!conversationId || !callType) {
      return res.status(400).json({ error: "conversationId and callType required" });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: initiatorId,
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const initiator = await User.findById(initiatorId).select("name avatar");
    const isGroup = conversation.type === "group";
    const livekitRoomName = `call-${require("crypto").randomUUID()}`;

    const callLog = await CallLog.create({
      type: isGroup ? "group" : "dm",
      conversationId,
      initiator: initiatorId,
      participants: [{ userId: initiatorId, joinedAt: new Date(), status: "joined" }],
      callType,
      livekitRoomName,
      status: "active",
    });

    // Emit call:incoming to all other participants via socket
    const io = req.app.get("io");
    const callPayload = {
      callId: callLog._id,
      callType,
      initiator: { _id: initiatorId, name: initiator.name, avatar: initiator.avatar },
      conversationId,
      roomName: livekitRoomName,
    };

    conversation.participants.forEach((participantId) => {
      if (participantId.toString() !== initiatorId.toString()) {
        io.to(`user:${participantId}`).emit("call:incoming", callPayload);
      }
    });

    res.json({ callId: callLog._id, roomName: livekitRoomName, callType });
  } catch (error) {
    console.error("Call initiation error:", error);
    res.status(500).json({ error: "Failed to initiate call" });
  }
});

module.exports = router;
