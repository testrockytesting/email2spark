var api_key = process.env.MAILGUN_API_KEY;
var emaildomain = process.env.DOMAIN;
var mailgun = require('mailgun-js')({apiKey: api_key, domain: emaildomain});
var Promise = require("bluebird");
var CiscoSparkClient = require('node-sparkclient')
var express = require('express');
var bodyParser = require("body-parser")
var addrs = require("email-addresses")
var multer = require('multer')
var upload = multer()
var app = express();
var port = process.env.PORT
var bot_email = process.env.BOT_EMAIL
var bot_id = process.env.BOT_ID
var botAccessToken = process.env.BOT_ACCESS_TOKEN
var sparkClient = new CiscoSparkClient(botAccessToken)
var pmx = require('pmx');

var prefixesToStrip = ['RE','FW']

//  Helper functions

function decodeBase64(base64) {
    // Add removed at end '='
    base64 += Array(5 - base64.length % 4).join('=');
    base64 = base64
        .replace(/\-/g, '+') // Convert '-' to '+'
        .replace(/\_/g, '/'); // Convert '_' to '/'
    return (new Buffer(base64, 'base64')).toString();
}

function stripPrefixes(prefixesToStrip, subject)
{
    var a = subject.split(' ')
    for (var i=0;i< a.length; i++)
        for (var j = 0; j<prefixesToStrip.length; j++) {

            if (a[i].replace(":", "").toUpperCase() == prefixesToStrip[j]) {
                a.shift()
                i=i-1;
                break;
            }
        }
        return (a.join(' '))
}

function createRoom(title) {
  return new Promise(function (fulfill, reject){
      sparkClient.createRoom(title,function(err,room){
        if (err) {
            reject(err)
        }
        else {
            fulfill(room)
        }
      })
  })
}

function leaveRoom(roomId)
{
  return new Promise(function (fulfill, reject){
      sparkClient.listMemberships(roomId,function(err,memberships){
        if (!err)
        {
          var membershipId = ""
           for (i=0;i<memberships.items.length;i++)
           {
             if (memberships.items[i].personEmail == bot_id)
             {
               membershipId = memberships.items[i].id
               break;
             }
           }
           sparkClient.deleteMembership(membershipId, function(err,mem){
             if (!err)
               fulfill(mem)
             else {
               reject(err)
             }
           })
         }
         else {
           reject(err)
         }
      })
  })
}

function addPersonToRoom(roomId,personEmail) {
  return new Promise(function (fulfill, reject){
      sparkClient.createMembership(roomId,personEmail,function(err,membership){
        if (err) {
            reject(err)
        }
        else {
            fulfill(membership)
        }
      })
  })
}

function postMessage(roomId,message) {
  return new Promise(function (fulfill, reject){
       var sanitizedMessage = '>'+message.replace(/\n/g,"<br>")
      sparkClient.createMessage(roomId,sanitizedMessage,{markdown:true},function(err,message){
        if (err) {
            reject(err)
        }
        else {
            fulfill(message)
        }
      })
  })
}


// Express stuff
app.use(bodyParser.urlencoded({'limit': '50mb', extended: false }));
app.use(bodyParser.json({'limit': '50mb'}));
app.use(bodyParser.raw({'limit': '50mb'}));
app.use(bodyParser.text({'limit': '50mb'}));

// Just to see if we are still alive
app.get('/ping', function (req, res) {
  res.send("PONG")
})

// main route for mailgun webhook
app.post('/mailgun', upload.any(),function(req, res, next){
  // we can respond back to the webhook right away.
  res.end('ok');
  var emailBody = req.body
  if (emailBody == null || emailBody.To == null || emailBody.From == null || emailBody.subject == null)
   {
     console.error("Invalid posted parameters")
     return
   }
  var owner  = emailBody.sender
  var j = 0
  var participants=[]
  var From = addrs.parseOneAddress(emailBody.From)
  var To = addrs.parseAddressList(emailBody.To)
  var Cc = addrs.parseAddressList(emailBody.Cc)
  var Bcc = addrs.parseAddressList(emailBody.Bcc)
  var Subject = stripPrefixes(prefixesToStrip, emailBody.subject)
  var found = false
  var lower_owner = owner.toLowerCase()
  var messageUrl = emailBody['message-url']
  var domain =lower_owner.split('@')

  // Add Sender to the list people to add to the spark room
  participants[j++]=owner

  // Grab all the emails in the To field.
  if (To) {
    for (var i =0; i< To.length; i++)
    {
      var ta = To[i].address.toLowerCase()
      
      if (ta != bot_email)
      {
        if (participants.indexOf(ta) < 0)
        participants[j++] = ta
      }
      else
      {
        var text ="Hi There,\n\n We couldn't create a Spark room for you because "+bot_email+" was found to be in the TO field.  Please try again by replying all to the original email and adding "+bot_email+" only to the BCC field.\n\nRegards,\nEmail2Spark Team"
        var emailText = emailBody['body-plain']
        var data = {
            from: 'no-reply@'+emaildomain,
            to: owner,
            subject: "Error - " + Subject,
            text: text
        };

        mailgun.messages().send(data, function (error, body) {
            if (error)
              console.error(error);
        });
        return;
      }

    }
  }

  // Grab all the emails in the CC field.
  if(Cc) {
    for (var i =0; i< Cc.length; i++)
    {
      var ca =  Cc[i].address.toLowerCase()
      if (ca != bot_email)
      {
        if (participants.indexOf(ca) < 0)
        participants[j++] = ca
      }
      else
      {
        var text ="Hi There,\n\n We couldn't create a Spark room for you because "+bot_email+" was found to be in the CC field.  Please try again by replying all to the original message and adding "+bot_email+" only to the BCC field.\n\nRegards,\nEmail2Spark Team"
        var emailText = emailBody['body-plain']
        var data = {
            from: 'no-reply@'+emaildomain,
            to: owner,
            subject: "Error - " + Subject,
            text: text
        };

        mailgun.messages().send(data, function (error, body) {
          if (error)
            console.error(error);
        });
        return;
        }
      }
    }
    // Create the room and add all the participants and then leave.
    createRoom(Subject)
    .then(function(room){
      console.log("New room created: "+Subject)
      Promise.map(participants, function (email) {
             console.log("Adding: "+email)

              return new Promise(function (fulfill, reject){            
                addPersonToRoom(room.id,email)
                .then(function(success){
                  fulfill(email)
                })
                .catch(function(ex){
                  pmx.emit('error:adding participant', {
                     error: ex
                  });
                  fulfill("")
                })
              })
      },{concurrency:1})
      .then(function(emails){
            var roomUUID_Regex = /ciscospark:\/\/.+\/.+\/(.+)/
            var roomUri = decodeBase64(room.id)
            var roomUUID = roomUri.match(roomUUID_Regex)
            var text ='Hello email users,\n\nThis discussion has been moved to Cisco Spark by '+ owner + '\nClick the link below to enter the room.\n\nhttps://web.ciscospark.com/launch/rooms/'+roomUUID[1]+'\n\nIf you have an email thread that you want to move to Cisco Spark, just reply all and BCC: move@email2spark.com\n\nRegards,\nEmail2Spark Team'
            var emailText = emailBody['body-plain']
            var data = {
                from: 'no-reply@'+emaildomain,
                to: participants,
                subject: Subject,
                text: text
            };

            mailgun.messages().send(data, function (error, body) {
              if (error)
                console.error(error);
            });
            return postMessage(room.id,emailBody.From+' wrote:\n\n'+emailText.substr(0,4000))
                  .then(function(message){
                    return leaveRoom(room.id)
                  })
      })
      .then(function(membership){
        console.log("Left room")
      })
      .catch(function(ex){
        console.log("Exception: "+ex)
      })
    })
    .catch(function(ex){
      var text ="Hi There,\n\n Something went wrong when creating the Spark room. We will look into the issue ASAP.\n\nRegards,\nEmail2Spark Team"
      var emailText = emailBody['body-plain']
      var data = {
          from: 'no-reply@'+emaildomain,
          to: owner,
          subject: "Error - " + Subject,
          text: text
      };

      mailgun.messages().send(data, function (error, body) {
        if (error)
          console.error(error);
      });
    })
});
// Create an HTTP service.
app.listen(port);
console.log('App server listening on',port);
