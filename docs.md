# Development Logs

# Mahir - Authentication Flow

### 1. User Model

- Defined the `User` schema in `src/models/User.js`.
- Implemented automatic timestamps.
- Added field validations for name, email (unique/trimmed), and hashed passwords.

### 2. JWT Authentication Middleware

- Created `src/middleware/auth.middleware.js`.
- Implemented logic to extract Bearer tokens from the `Authorization` header.
- Added JWT verification to protect sensitive routes.

### 3. Auth Controller & Routes

- Built `src/controllers/auth.controller.js` with three core functions:
  - `register`: Handles password hashing with salt (10 rounds) and user creation.
  - `login`: Validates credentials and returns a 7-day JWT.
  - `me`: Returns the logged-in user's profile (safely excluding the password).
- Wired everything together in `src/routes/auth.routes.js`.

### 4. Server Integration

- Updated `index.js` to:
  - Load environment variables using `dotenv`.
  - Initialize the database connection.
  - Register the `/auth` route group.
- Configured `.env` with a secure `JWT_SECRET`.
- Added `npm run dev` script to `package.json` for easier testing.
