import crypto from 'crypto';
import {readFileSync, writeFileSync} from 'fs';

const users = readFileSync("users.secret").toString().split("\r\n");
const salt = readFileSync("salt.secret").toString();

const refCodes = users.map(user => {
    const hash = crypto.createHmac('sha256', salt).update(user).digest('hex');
    return {user: user, secret: hash};
});

const csv = refCodes.map(refCode => `${refCode.user},bid_${refCode.secret.substring(0, 20)}`).join("\n");

writeFileSync("ref-codes.secret", csv);