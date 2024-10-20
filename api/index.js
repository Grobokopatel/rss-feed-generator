import dotenv from 'dotenv';

dotenv.config();

import {fileURLToPath} from 'url';
import {dirname} from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {HttpsProxyAgent} from "https-proxy-agent";
import fetch from 'node-fetch';
import urlNode from "node:url";
import cons from "@ladjs/consolidate";
import {Feed} from "feed";
import * as cheerio from 'cheerio';
import {sql} from "@vercel/postgres";
import path from "node:path";
import express from "express";

const app = express();


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
                link: url
            };

            let {
                title,
                description,
                imageEnclosure
            } = await getTitleDescriptionAndImageEnclosure(cheerioAPI, selectors, url);

            post.title = title;
            post.description = description;
            post.image = imageEnclosure;

            let currentContent = post.title + ';' + post.description + ';' + imageEnclosure?.url;

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

async function getTitleDescriptionAndImageEnclosure(cheerioAPI, selectors, url) {
    return {
        title: cheerioAPI(selectors.title).prop('innerText'),
        description: cheerioAPI(selectors.description).html(),
        imageEnclosure: await getImageEnclosure(selectors.image, url, cheerioAPI),
    };
}

async function getImageEnclosure(imageSelector, url, cheerioAPI) {
    if (!imageSelector)
        return null;

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
        path: `/my_feeds/${queryResult.rows[0].id}`,
        url: `https://${process.env.VERCEL_URL}/${queryResult.rows[0].id}`
    });
});

app.post('/preview', async (req, res) => {
    let body = req.body;
    let cheerioAPI = await cheerio.fromURL(body.url);
    let selectors = {title: body.title, description: body.description, image: body.image};
    let {
        title,
        description,
        imageEnclosure
    } = await getTitleDescriptionAndImageEnclosure(cheerioAPI, selectors, body.url);
    res.render('example', {title, description, image: imageEnclosure?.url});
});

app.get('/proxy_check', async (req, res) => {
    const agent = new HttpsProxyAgent('http://178.177.54.157:8080');
    let response = await fetch('https://webhook.site/6f1c73de-153b-4666-8751-3ea5778f5189', {agent});
    let text = await response.text();

    res.send(text);
});

app.get('/system_variables_check', async (req, res) => {
    console.log(process.env);
    let env = process.env;
    env.url = `https://${process.env.VERCEL_URL}`;
    res.json(env);
});

app.get('/current_directory', async (req, res) => {
    res.json({__dirname, process_cwd: process.cwd()});
});

export default app;