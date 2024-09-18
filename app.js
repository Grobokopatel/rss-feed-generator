const express = require('express');
const path = require('node:path');
const app = express();
const port = 3000;
const Parser = require('rss-parser');
const parser = new Parser();

app.use(express.static('.'));

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
});

app.get('/', (req, res) => {
    res.sendFile(path.resolve('static', 'index.html'));
});

app.put('/user', (req, res) => {
    res.send('Got a PUT request at /user')
});


