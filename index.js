const express = require('express');
const cors = require('cors');

const port = process.env.PORT || 3000;
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

app.get('/',(req, res) => {
    res.send("Hey buddy no tension I am [ConvoX Server] Running...");
})


app.listen(port, () => {
    console.log(`ConvoX Server is running on port ${port}`);
})