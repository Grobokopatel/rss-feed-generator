const express = require('express');
const path = require('node:path');
const app = express();
const port = 5000;
const Parser = require('rss-parser');
const parser = new Parser();

app.use(express.static(path.join('static')));

/*app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})*/


app.get('/', (req, res) => {
    res.sendFile('index.html');
});

app.get('/test', (req, res) => {
    res.send('foobar');
});

app.put('/user', (req, res) => {
    res.send('Got a PUT request at /user')
});



module.exports = app;

