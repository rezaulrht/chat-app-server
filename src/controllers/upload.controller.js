// chat-app-server/src/controllers/upload.controller.js
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { v4: uuidv4 } = require("uuid");
const r2Client = require("../config/r2");
const axios = require("axios");
const FormData = require("form-data");

const VIDEO_MAX = 100 * 1024 * 1024;  // 100 MB
const OTHER_MAX = 50 * 1024 * 1024;   // 50 MB
const MAX_FILES = 5;

/**
 * POST /api/upload/presign
 * Body: [{ filename, contentType, size }]
 * Returns: [{ presignedUrl, publicUrl, key }]
 */
const presign = async (req, res) => {
  try {
    const files = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ message: "files array is required" });
    }
    if (files.length > MAX_FILES) {
      return res.status(400).json({ message: `Max ${MAX_FILES} files per upload` });
    }

    // Validate each file
    for (const file of files) {
      const { filename, contentType, size } = file;
      if (!filename || typeof size !== "number") {
        return res.status(400).json({ message: "Each file needs filename and size" });
      }
      const isVideo = (contentType || "").startsWith("video/");
      const limit = isVideo ? VIDEO_MAX : OTHER_MAX;
      if (size > limit) {
        return res.status(400).json({
          message: `${filename} exceeds size limit (${isVideo ? "100MB" : "50MB"})`,
        });
      }
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");

    const results = await Promise.all(
      files.map(async ({ filename, contentType, size }) => {
        // Extract extension from filename (safe — server-generated key)
        const lastDot = filename.lastIndexOf(".");
        const ext = lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
        const key = `uploads/${year}/${month}/${uuidv4()}${ext ? "." + ext : ""}`;

        const effectiveContentType = contentType || "application/octet-stream";

        const command = new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
          ContentType: effectiveContentType,
        });

        const presignedUrl = await getSignedUrl(r2Client, command, {
          expiresIn: 300, // 5 minutes
        });

        const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

        return { presignedUrl, publicUrl, key };
      })
    );

    return res.json(results);
  } catch (err) {
    console.error("presign error:", err.message);
    return res.status(500).json({ message: "Failed to generate upload URL" });
  }
};

// Upload image to ImgBB
const uploadAvatar = async (req, res) => {
  try {
    const { image } = req.body;

    // Validate image is a non-empty string
    if (typeof image !== "string" || !image.trim()) {
      return res.status(400).json({ message: "Invalid image data" });
    }

    // Remove the data:image/...;base64, prefix if it exists
    const base64Image = image.replace(/^data:image\/\w+;base64,/, "");

    // Create form data for ImgBB
    const formData = new FormData();
    formData.append("image", base64Image);

    // Upload to ImgBB with timeout
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 10000, // 10 seconds timeout
      },
    );

    // Return uploaded image URL
    if (response.data?.data?.url) {
      return res.json({
        success: true,
        url: response.data.data.url,
        deleteUrl: response.data.data.delete_url,
      });
    } else {
      return res.status(500).json({
        message: "Failed to upload image to ImgBB",
      });
    }
  } catch (err) {
    // Handle timeout specifically
    if (err.code === "ECONNABORTED") {
      console.error("ImgBB upload timeout");
      return res.status(504).json({ message: "Image upload timed out" });
    }

    console.error("ImgBB upload error:", err.response?.data || err.message);
    res.status(500).json({
      message: "Upload failed",
      error: err.response?.data?.error?.message || err.message,
    });
  }
};


module.exports = { presign, uploadAvatar };