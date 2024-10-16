require('dotenv').config();

const express = require('express');
const path = require('node:path');
const app = express();
const {sql} = require('@vercel/postgres');
const cheerio = require('cheerio');
const {Feed} = require("feed");
const cons = require('@ladjs/consolidate');
const urlNode = require('node:url');

app.engine('handlebars', cons.handlebars);
app.use(express.urlencoded({extended: true}));
app.use(express.static(path.join(__dirname, '..', 'static')));
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'handlebars');


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'static', 'index.html'));
});

app.get('/my_feeds/:id', async (req, res) => {
    let queryResult;
    try {
        queryResult = await sql`
            select id, url, selectors, last_time_updated, content
            from feed
            where id = ${req.params.id};
        `;
    } catch (error) {
        console.error(error);
        res.status(500).json({error});
        return;
    }

    let {rows} = queryResult;
    if (rows.length === 0) {
        res.status(404).send(`Нет ленты с таким id: ${req.params.id}`);
        return;
    } else {
        let {id, url, selectors, last_time_updated, content} = rows[0];
        try {
            let cheerioAPI = await cheerio.fromURL(url);
            
            let post = {
                link: url,
                title: cheerioAPI(selectors.title).prop('innerText'),
                description: cheerioAPI(selectors.description).html(),
            };

            let imageUrl = undefined;
            if (selectors.image) {
                post.image = await getImageEnclosure(selectors.image, url, cheerioAPI);
                imageUrl = post.image.url;
            }

            let currentContent = post.title + ';' + post.description + ';' + imageUrl;

            let lastTimeUpdated = last_time_updated;
            if (content !== currentContent) {
                lastTimeUpdated = new Date();
                
                await sql`
                    update feed
                    set last_time_updated = ${lastTimeUpdated},
                        content           = ${currentContent}
                    where id = ${id};
                `;
            }

            post.id = url + '#' + +lastTimeUpdated;
            post.date = lastTimeUpdated;

            const feed = new Feed({
                title: cheerioAPI('title').html(),
                description: "Сайт для генерации собственных RSS лент",
                link: url,
                language: "ru",
            });
            
            feed.addItem(post);
            let rssPost = feed.rss2();
            res.contentType('text/xml').send(rssPost);
            return;
        } catch (error) {
            console.error(error);
            res.status(500).json({error});
            return;
        }
    }
});

async function getImageEnclosure(imageSelector, url, cheerioAPI) {
    let imageElement = cheerioAPI(imageSelector);
    let imageUrl = imageElement.prop('src');
    if (imageUrl === undefined) {
        imageUrl = imageElement.find('img[src]').prop('src');
    }

    imageUrl = urlNode.resolve(url, imageUrl);
    let imageInfo = await fetch(imageUrl, {method: 'HEAD'});
    let headers = imageInfo.headers;

    return {
        url: imageUrl,
        type: headers.get('content-type'),
        length: parseInt((headers.get('content-length'))),
    };
}

app.post('/', async (req, res) => {
    let body = req.body;
    let selectors = {title: body.title, description: body.description, image: body.image};
    let queryResult;
    let today = new Date();
    try {
        queryResult = await sql`
            insert into feed(url, selectors, last_time_updated)
            values (${body.url},
                    ${selectors},
                    ${today})
            returning id;
        `;
    } catch (error) {
        console.error(error);
        res.status(500).json({error});
        return;
    }

    res.render('preview', {
        url: `/my_feeds/${queryResult.rows[0].id}`
    });
});

module.exports = app;

