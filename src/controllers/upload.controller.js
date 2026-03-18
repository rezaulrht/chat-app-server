const axios = require("axios");
const FormData = require("form-data");

// Upload image to ImgBB
exports.uploadAvatar = async (req, res) => {
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
