const axios = require("axios");
const FormData = require("form-data");

// Upload image to ImgBB
exports.uploadAvatar = async (req, res) => {
  try {
    // Check if image data is provided
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ message: "No image data provided" });
    }

    // Remove the data:image/...;base64, prefix if it exists
    const base64Image = image.replace(/^data:image\/\w+;base64,/, "");

    // Create form data for ImgBB
    const formData = new FormData();
    formData.append("image", base64Image);

    // Upload to ImgBB
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      formData,
      {
        headers: formData.getHeaders(),
      },
    );

    if (response.data && response.data.data && response.data.data.url) {
      return res.json({
        success: true,
        url: response.data.data.url,
        deleteUrl: response.data.data.delete_url,
      });
    } else {
      return res
        .status(500)
        .json({ message: "Failed to upload image to ImgBB" });
    }
  } catch (err) {
    console.error("ImgBB upload error:", err.response?.data || err.message);
    res.status(500).json({
      message: "Upload failed",
      error: err.response?.data?.error?.message || err.message,
    });
  }
};
