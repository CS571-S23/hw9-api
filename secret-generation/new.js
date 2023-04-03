import {readFileSync} from 'fs';

const oldUsers = readFileSync("users.secret").toString().split("\r\n");
const newUsers = readFileSync("new.secret").toString().split("\r\n");

console.log("New users...")
newUsers.forEach(nu => {
    if (!oldUsers.includes(nu)) {
        console.log(nu);
    }
});
console.log("Done!");
console.log("Add these to users.secret, re-generate, and send emails.")
