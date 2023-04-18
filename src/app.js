
import express from 'express';
import { format } from 'path';
import { exit } from 'process';

import jwt from 'jsonwebtoken';

import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import errorHandler from 'errorhandler';
import morgan from 'morgan';

import bodyParser from 'body-parser';
import { readFileSync } from 'fs';

const app = express();
const port = 25410;

const COLE_LOCAL = false;
const FS_DB = COLE_LOCAL ? "./db.db" : "/secrets/db.db";
const FS_SESSION_SECRT = COLE_LOCAL ? "C:/Users/ColeNelson/Desktop/cs571-s23/hws/apis/hw10-api/secret-generation/session-secret.secret" : "/secrets/session-secret.secret";
const FS_INIT_SQL = COLE_LOCAL ? "C:/Users/ColeNelson/Desktop/cs571-s23/hws/apis/hw10-api/includes/init.sql" : "/secrets/init.sql";
const FS_XID_ASSOCIATIONS = COLE_LOCAL ? "C:/Users/ColeNelson/Desktop/cs571-s23/hws/apis/hw10-api/secret-generation/ref-codes.secret" : "/secrets/ref-codes.secret";

const XID_ASSOCIATIONS = Object.fromEntries(readFileSync(FS_XID_ASSOCIATIONS)
    .toString().split(/\r?\n/g).map(assoc => {
        const assocArr = assoc.split(',');
        return [assocArr[1], assocArr[0]]
    })
);

const XIDS = Object.keys(XID_ASSOCIATIONS);

const SESSION_SECRET = readFileSync(FS_SESSION_SECRT).toString()
const INIT_SQL = readFileSync(FS_INIT_SQL).toString();

const EXISTS_POST_SQL = 'SELECT * FROM BadgerMessage WHERE chatroom = ? AND id = ?;'
const EXISTS_USER_SQL = 'SELECT * FROM BadgerUser WHERE username = ?;'
const REGISTER_SQL = "INSERT INTO BadgerUser(username, passwd, salt, xcsid, wiscUsername) VALUES(?, ?, ?, ?, ?);";
const GET_POSTS_SQL = "SELECT * From BadgerMessage WHERE chatroom = ? ORDER BY id DESC LIMIT 25;"
const POST_SQL = "INSERT INTO BadgerMessage(poster, title, content, chatroom, created) VALUES (?, ?, ?, ?, ?) RETURNING id;"
const DELETE_POST_SQL = "DELETE FROM BadgerMessage WHERE id = ?;"

const CHATROOM_NAMES = ["Bascom", "Brogden", "Chamberlin", "Grainger", "Ingraham", "VanVleck", "Vilas"]

function generateAccessToken(tokenBody) {
    return jwt.sign(tokenBody, SESSION_SECRET, { expiresIn: '3600s' });
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]

    if (token) {
        jwt.verify(token, SESSION_SECRET, (err, user) => {
            if (err) {
                return res.status(401).send({
                    msg: "You must be logged in to make a post!"
                });
            }
            req.user = user
            next()
        })
    } else {
        return res.status(401).send({
            msg: "Missing \'Authorization\' header. Did you forget to prefix with \'Bearer\'?"
        });
    }
}

const db = await new sqlite3.Database(FS_DB, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.log("Failed to create/open SQL database!");
        exit(1);
    } else {
        console.log("Created/opened SQL database!")
    }
});
db.serialize(() => {
    INIT_SQL.replaceAll(/\t\r\n/g, ' ').split(';').filter(str => str).forEach((stmt) => db.run(stmt + ';'));
});

app.use(morgan((tokens, req, res) => {
    return [
        tokens.date(),
        tokens['remote-addr'](req, res),
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        lookupXid(req.header('X-CS571-ID')),
        tokens['response-time'](req, res), 'ms'
    ].join(' ')
}));
morgan.token('date', function () {
    var p = new Date().toString().replace(/[A-Z]{3}\+/, '+').split(/ /);
    return (p[2] + '/' + p[1] + '/' + p[3] + ':' + p[4] + ' ' + p[5]);
});

// Require WISC Badger ID
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        next();
    } else if (!req.header('X-CS571-ID')) {
        res.status(401).send({
            msg: "You must specify a header X-CS571-ID!"
        });
    } else if (!XIDS.includes(req.header('X-CS571-ID').toLowerCase())) {
        res.status(401).send({
            msg: "You specified an invalid X-CS571-ID!"
        });
    } else {
        next();
    }
});

process.on('uncaughtException', function (exception) {
    console.log(exception);
});

process.on('unhandledRejection', (reason, p) => {
    console.log("Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

app.use(errorHandler());

// JSON Body Parser Configuration
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());

// // Request Throttler

// Throttling
app.use(rateLimit({
    message: {
        msg: "Too many requests, please try again later."
    },
    windowMs: 30 * 1000, // 30 seconds
    max: (req, res) => req.method === "OPTIONS" ? 0 : 100, // limit each client to 100 requests every 30 seconds
    keyGenerator: (req, res) => req.header('X-CS571-ID') // throttle on BID
}));
app.set('trust proxy', 1);

// Allow CORS
app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT,OPTIONS');
    next();
});

app.post('/api/register', (req, res) => {
    const username = req.body.username?.trim();
    const password = req.body.password?.trim();
    if (username && password) {
        if (username.length <= 64 && password.length <= 128) {
            db.prepare(EXISTS_USER_SQL).run(username).all((err, rows) => {
                if (err) {
                    res.status(500).send({
                        msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                        error: err
                    });
                } else if (rows.length === 1) {
                    res.status(409).send({
                        msg: "The user already exists!",
                    });
                } else {
                    const salt = crypto.createHash('sha256').update(new Date().getTime().toString()).digest('hex');
                    const hashPass = crypto.createHmac('sha256', salt).update(password).digest('hex');
                    const wiscRef = XID_ASSOCIATIONS[req.header('X-CS571-ID')];
                    db.prepare(REGISTER_SQL).run(username, hashPass, salt, req.header('X-CS571-ID'), wiscRef, (err) => {
                        if (err) {
                            res.status(500).send({
                                msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                                error: err
                            });
                        } else {
                            db.prepare(EXISTS_USER_SQL).run(username).all((err, rows) => {
                                if (!err && rows.length === 1) {
                                    const idAndUsername = (({ id, username }) => ({ id, username }))(rows[0]);
                                    const jwtToken = generateAccessToken(idAndUsername);
                                    res.status(200).send({
                                        msg: "Successfully authenticated.",
                                        user: idAndUsername,
                                        token: jwtToken
                                    });
                                } else {
                                    res.status(500).send({
                                        msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                                        error: err
                                    });
                                }
                            });
                        }
                    });
                }
            });
        } else {
            res.status(413).send({
                msg: '\'username\' must be 64 characters or fewer and \'password\' must be 128 characters or fewer'
            })
        }
    } else {
        res.status(400).send({
            msg: 'A request must contain a \'username\' and \'password\''
        });
    }
});

app.post('/api/login', (req, res) => {
    const username = req.body.username?.trim();
    const password = req.body.password?.trim();

    if (username && password) {
        db.prepare(EXISTS_USER_SQL).run(username).all((err, rows) => {
            if (err) {
                res.status(500).send({
                    msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                    error: err
                });
            } else if (rows.length === 0) {
                // Acceptable Risk: Username exfiltration.
                res.status(404).send({
                    msg: "That user does not exist!",
                });
            } else {
                const dbUser = rows[0];
                const dbPass = dbUser.passwd;
                const dbSalt = dbUser.salt;
                const guessPass = crypto.createHmac('sha256', dbSalt).update(password).digest('hex');
                if (guessPass === dbPass) {
                    const idAndUsername = (({ id, username }) => ({ id, username }))(dbUser);
                    const jwtToken = generateAccessToken(idAndUsername);
                    res.status(200).send({
                        msg: "Successfully authenticated.",
                        user: {
                            id: dbUser.id,
                            username: dbUser.username,
                        },
                        token: jwtToken
                    });
                } else {
                    res.status(401).send({
                        msg: "Incorrect password.",
                    });
                }
            }
        });
    } else {
        res.status(400).send({
            msg: 'A request must contain a \'username\' and \'password\''
        })
    }
});

app.get('/api/chatroom', (req, res) => {
    res.status(200).send(CHATROOM_NAMES);
});

app.get('/api/chatroom/:chatroomName/messages', (req, res) => {
    const chatroomName = req.params.chatroomName;
    if (CHATROOM_NAMES.includes(chatroomName)) {
        db.prepare(GET_POSTS_SQL).run(chatroomName).all((err, rows) => {
            if (!err) {
                res.status(200).send({
                    msg: "Successfully got the latest messages!",
                    messages: rows
                });
            } else {
                res.status(500).send({
                    msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                    error: err
                });
            }
        });
    } else {
        res.status(404).send({
            msg: "The specified chatroom does not exist. Chatroom names are case-sensitive."
        })
    }
});

app.post('/api/chatroom/:chatroomName/messages', authenticateToken, (req, res) => {
    const title = req.body.title?.trim();
    const content = req.body.content?.trim();
    const chatroomName = req.params.chatroomName;

    if (CHATROOM_NAMES.includes(chatroomName)) {
        if (title && content) {
            if (title.length <= 128 && content.length <= 1024) {
                db.prepare(POST_SQL).get(req.user.username, title, content, chatroomName, new Date(), (err, resp) => {
                    if (!err) {
                        res.status(200).send({
                            msg: "Successfully posted message!",
                            id: resp.id
                        });
                    } else {
                        res.status(500).send({
                            msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                            error: err
                        });
                    }
                });
            } else {
                res.status(413).send({
                    msg: '\'title\' must be 128 characters or fewer and \'content\' must be 1024 characters or fewer'
                })
            }
        } else {
            res.status(400).send({
                msg: 'A request must contain a \'title\' and \'content\''
            })
        }
    } else {
        res.status(404).send({
            msg: "The specified chatroom does not exist. Chatroom names are case-sensitive."
        })
    }
});

app.get('/api/whoami', authenticateToken, (req, res) => {
    return res.status(200).send({
        user: req.user
    });
})

app.delete('/api/chatroom/:chatroomName/messages/:messageId', authenticateToken, (req, res) => {
    const chatroomName = req.params.chatroomName;
    const messageId = req.params.messageId;

    if (CHATROOM_NAMES.includes(chatroomName)) {
        db.prepare(EXISTS_POST_SQL).run(chatroomName, messageId).all((err, rows) => {
            if (err) {
                res.status(500).send({
                    msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                    error: err
                });
            } else if (rows.length === 0) {
                res.status(404).send({
                    msg: "That message does not exist!"
                });
            } else if (req.user.username !== rows[0].poster) {
                res.status(401).send({
                    msg: "You may not delete another user's post!"
                });
            } else {
                db.prepare(DELETE_POST_SQL).run(messageId, (err) => {
                    if (!err) {
                        res.status(200).send({
                            msg: "Successfully deleted message!"
                        });
                    } else {
                        res.status(500).send({
                            msg: "The operation failed. The error is provided below. This may be server malfunction; check that your request is valid, otherwise contact CS571 staff.",
                            error: err
                        });
                    }
                });
            }
        });
    } else {
        res.status(404).send({
            msg: "The specified chatroom does not exist. Chatroom names are case-sensitive."
        })
    }
});

// Error Handling
app.use((err, req, res, next) => {
    console.log("Encountered an erroneous request!")
    let datetime = new Date();
    let datetimeStr = `${datetime.toLocaleDateString()} ${datetime.toLocaleTimeString()}`;
    res.status(500).send({
        "error-msg": "Oops! Something went wrong. Check to make sure that you are sending a valid request. Your recieved request is provided below. If it is empty, then it was most likely not provided or malformed. If you have verified that your request is valid, please contact the CS571 staff.",
        "error-req": JSON.stringify(req.body),
        "date-time": datetimeStr
    })
});

// XID Lookup
function lookupXid(xId) {
    if (XIDS.includes(xId)) {
        return XID_ASSOCIATIONS[xId];
    } else {
        return "anonymous"
    }
}

// Open Server for Business
app.listen(port, () => {
    console.log(`CS571 API :${port}`)
});
