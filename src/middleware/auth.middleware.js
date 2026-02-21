const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
    // Get token from header
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ message: "No token, authorization denied" });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Add user from payload
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: "Token is not valid" });
    }
};
