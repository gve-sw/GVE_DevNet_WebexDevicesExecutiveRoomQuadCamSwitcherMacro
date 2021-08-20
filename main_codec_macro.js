/*
Copyright (c) 2021 Cisco and/or its affiliates.
This software is licensed to you under the terms of the Cisco Sample
Code License, Version 1.1 (the "License"). You may obtain a copy of the
License at
               https://developer.cisco.com/docs/licenses
All use of the material herein must be in accordance with the terms of
the License. All rights not expressly granted by the License are
reserved. Unless required by applicable law or agreed to separately in
writing, software distributed under the License is distributed on an "AS
IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
or implied.
*/
/////////////////////////////////////////////////////////////////////////////////////////
// REQUIREMENTS
/////////////////////////////////////////////////////////////////////////////////////////

const xapi = require('xapi');

/////////////////////////////////////////////////////////////////////////////////////////
// CONSTANTS/ENUMS
/////////////////////////////////////////////////////////////////////////////////////////

// IP Address of AUX codec (i.e. CodecPlus)
const AUX_CODEC_IP ='10.10.10.10';

// AUX_CODEC_USERNAME and AUX_CODEC_PASSWORD are the username and password of a admin-level user on the Auxiliary codec
// Here are instructions on how to configure local user accounts on Webex Devices: https://help.webex.com/en-us/jkhs20/Local-User-Administration-on-Room-and-Desk-Devices)
const AUX_CODEC_USERNAME='username';
const AUX_CODEC_PASSWORD='password';

// This next line hides the mid-call controls “Lock meeting” and “Record”.  The reason for this is so that the
// “Camera Control” button can be seen.  If you prefer to have the mid-call controls showing, change the value of this from “Hidden” to “Auto”
xapi.Config.UserInterface.Features.Call.MidCallControls.set("Hidden");

function encode(s) {
    var c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
    o = [];
    for (var i = 0, n = s.length; i < n;) {
      var c1 = s.charCodeAt(i++),
      c2 = s.charCodeAt(i++),
      c3 = s.charCodeAt(i++);
      o.push(c.charAt(c1 >> 2));
      o.push(c.charAt(((c1 & 3) << 4) | (c2 >> 4)));
      o.push(c.charAt(i < n + 2 ? ((c2 & 15) << 2) | (c3 >> 6) : 64));
      o.push(c.charAt(i < n + 1 ? c3 & 63 : 64));
    }
  return o.join("");
}

const AUX_CODEC_AUTH=encode(AUX_CODEC_USERNAME+':'+AUX_CODEC_PASSWORD);

// Microphone High/Low Thresholds
const MICROPHONELOW  = 6;
const MICROPHONEHIGH = 25;


// Microphone Input Numbers to Monitor
// Specify the input connectors associated to the microphones being used in the room
// For example, if you set the value to [1,2,3,4,5,6,7,8] the macro will evaluate mic input id's 1-8 for it's switching logic
const CONNECTORS = [1,2,3,4,5,6,7,8];

// Camera source IDs that correspond to each microphone in CONNECTORS array
// Associate the connectors to specific input source ID corresponding to the camera that covers where the mic is located.
// For example, if you set the value to [1,1,1,1,2,2,2,2] and CONNECTORS = [1,2,3,4,5,6,7,8] you are specifying that
// mics 1,2,3 and 4 are located where Camera associated to video input 1 is pointing at and
// mics 5,6,7 and 8 are located where Camera associated to video input 2 is pointing at
const MAP_CAMERA_SOURCE_IDS = [1,1,1,1,2,2,2,2];

// overviewShowDouble defines what is shown on the far end (the video the main codec sends into the call or conference) when in "overview" mode where nobody is speaking or there is no
// prominent speaker detected by any of the microphones
// INSTRUCTIONS: If you are using side-by-side mode as your default - "overviewShowDouble = true" - then you must set up a camera preset for each Quad Camera
// with a Preset ID of 30.  The JavaScript for side-by-side mode uses Preset 30.
// EC - what happens if they set this value to false?  I know the function is "recallSideBySideMode" but I don't quite understand the logic in "let 
// sourceDict={ Source : '0'};"
const overviewShowDouble = true;

// OVERVIEW_SINGLE_SOURCE_ID specifies the source video ID to use when in overview mode if you set overviewShowDouble to false
const OVERVIEW_SINGLE_SOURCE_ID = 1;

// OVERVIEW_DOUBLE_SOURCE_IDS specifies the source video array of two IDs to use when in overview mode if you set overviewShowDouble to true
// it will display the two sources side by side on the main screen with the first value of the array on the
// left and the second on the right.
const OVERVIEW_DOUBLE_SOURCE_IDS = [2,1];

// Time to wait for silence before setting Speakertrack Side-by-Side mode
const SIDE_BY_SIDE_TIME = 7000; // 7 seconds
// Time to wait before switching to a new speaker
const NEW_SPEAKER_TIME = 2000; // 2 seconds
// Time to wait before activating automatic mode at the beginning of a call
const INITIAL_CALL_TIME = 15000; // 15 seconds


/////////////////////////////////////////////////////////////////////////////////////////
// VARIABLES
/////////////////////////////////////////////////////////////////////////////////////////
let AUX_CODEC={ enable: true, online: false, url: AUX_CODEC_IP, auth: AUX_CODEC_AUTH};
let micArrays={};
for (var i in CONNECTORS) {
    micArrays[CONNECTORS[i].toString()]=[0,0,0,0];
}
let lowWasRecalled = false;
let lastActiveHighInput = 0;
let allowSideBySide = true;
let sideBySideTimer = null;
let InitialCallTimer = null;
let allowCameraSwitching = false;
let allowNewSpeaker = true;
let newSpeakerTimer = null;
let manual_mode = true;


/////////////////////////////////////////////////////////////////////////////////////////
// INITIALIZATION
/////////////////////////////////////////////////////////////////////////////////////////



function evalFullScreen(value) {
	if (value=='On') {
		xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_FS_selfview', Value: 'on'});
	}
	else
	{
		xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_FS_selfview' , Value: 'off'});
	}
}

// evalFullScreenEvent is needed because we have to check when someone manually turns on full screen
// when self view is already selected... it will eventually check FullScreen again, but that should be
// harmless
function evalFullScreenEvent(value)
{
	if (value=='On') {
		xapi.Status.Video.Selfview.Mode.get().then(evalSelfView);
	}
	else
	{
		xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_FS_selfview', Value: 'off'});
	}
}

function evalSelfView(value) {
	if (value=='On') {
		xapi.Status.Video.Selfview.FullscreenMode.get().then(evalFullScreen);
	}
	else
	{
		xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_FS_selfview', Value: 'off'});
	}
}

function init() {
  console.log('init');
  // configure HTTP settings
  xapi.config.set('HttpClient Mode', 'On').catch(handleError);
  xapi.config.set('HttpClient AllowInsecureHTTPS:', 'True').catch(handleError);
  xapi.config.set('HttpClient AllowHTTP:', 'True').catch(handleError);

  // Stop any VuMeters that might have been left from a previous macro run with a different CONNECTORS constant
  // to prevent errors due to unhandled vuMeter events.
  xapi.Command.Audio.VuMeter.StopAll({ });

  // register callback for processing manual mute setting on codec
  xapi.Status.Audio.Microphones.Mute.on((state) => {
      console.log(`handleMicMuteResponse: ${state}`);

      if (state == 'On') {
          stopSideBySideTimer();
          setTimeout(handleMicMuteOn, 2000);
      }
      else if (state == 'Off') {
            handleMicMuteOff();
      }
  });

  // register callback for processing messages from aux_codec
  xapi.event.on('Message Send', handleMessage);

  // register event handlers for local events
  xapi.Status.Standby.State
	.on(value => {
					console.log(value);
             		 if (value=="Off") handleWakeUp();
             		 if (value=="Standby") handleShutDown();
	});

    // register handler for Widget actions
    xapi.event.on('UserInterface Extensions Widget Action', (event) =>
                            handleOverrideWidget(event));

    // register handler for Call Successful
    xapi.Event.CallSuccessful.on(async () => {
      console.log("Starting new call timer...");
      startAutomation();
      startInitialCallTimer();
    });

    // register handler for Call Disconnect
    xapi.Event.CallDisconnect.on(async () => {
        console.log("Turning off Self View....");
        xapi.Command.Video.Selfview.Set({ Mode: 'off'});
        stopAutomation();
    });

    //  set self-view toggle on custom panel depending on Codec status that might have been set manually
    xapi.Status.Video.Selfview.Mode.get().then(evalSelfView);

    // register to receive events when someone manually turns on self-view
    // so we can keep the custom toggle button in the right state
    xapi.Status.Video.Selfview.Mode.on(evalSelfView);

    // register to receive events when someone manually turns on full screen mode
    // so we can keep the custom toggle button in the right state if also in self view
    xapi.Status.Video.Selfview.FullscreenMode.on(evalFullScreenEvent);

    // next, set Automatic mode toggle switch on custom panel off since the macro starts that way
    xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_override', Value: 'off'});

}


/////////////////////////////////////////////////////////////////////////////////////////
// START/STOP AUTOMATION FUNCTIONS
/////////////////////////////////////////////////////////////////////////////////////////

function startAutomation() {
  console.log('startAutomation');
   //setting overall manual mode to false
   manual_mode = false;
   allowCameraSwitching = true;


    // Always turn on SpeakerTrack when the Automation is started. It is also turned on when a call connects so that
    // if it is manually turned off while outside of a call it goes back to the correct state
   xapi.command('Cameras SpeakerTrack Activate').catch(handleError);

   //registering vuMeter event handler
   xapi.event.on('Audio Input Connectors Microphone', (event) => {
        micArrays[event.id[0]].pop();
        micArrays[event.id[0]].push(event.VuMeter);

        // checking on manual_mode might be unnecessary because in manual mode,
        // audio events should not be triggered
        if (manual_mode==false)
        {
            // invoke main logic to check mic levels ans switch to correct camera input
            checkMicLevelsToSwitchCamera();
        }
    });
  // start VuMeter monitoring
  console.log("Turning on VuMeter monitoring...")
  for (var i in CONNECTORS) {
    xapi.command('Audio VuMeter Start', {
          ConnectorId: CONNECTORS[i],
          ConnectorType: 'Microphone',
          IntervalMs: 500,
          Source: 'AfterAEC'
    });
  }
  // set toggle button on custom panel to reflect that automation is turned on.
  xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_override', Value: 'on'});
}

function stopAutomation() {
         //setting overall manual mode to true
         manual_mode = true;
         console.log("Stopping all VuMeters...");
         xapi.Command.Audio.VuMeter.StopAll({ });
         console.log("Switching to MainVideoSource connectorID 1 ...");
         xapi.Command.Video.Input.SetMainVideoSource({ SourceId: 1});
         xapi.event.on('Audio Input Connectors Microphone', (event) => null);
         // set toggle button on custom panel to reflect that automation is turned off.
         xapi.command('UserInterface Extensions Widget SetValue', {WidgetId: 'widget_override', Value: 'off'});

}

/////////////////////////////////////////////////////////////////////////////////////////
// MICROPHONE DETECTION AND CAMERA SWITCHING LOGIC FUNCTIONS
/////////////////////////////////////////////////////////////////////////////////////////

function checkMicLevelsToSwitchCamera() {
  // make sure we've gotten enough samples from each mic in order to do averages
  if (allowCameraSwitching) {
         // figure out which of the inputs has the highest average level then perform logic for that input *ONLY* if allowCameraSwitching is true
          let array_key=largestMicValue();
          let array=[];
          array=micArrays[array_key];
          // get the average level for the currently active input
          let average = averageArray(array);
          //get the input number as an int since it is passed as a string (since it is a key to a dict)
          let input = parseInt(array_key);
          // someone is speaking
          if (average > MICROPHONEHIGH) {
            // start timer to prevent Side-by-Side mode too quickly
            restartSideBySideTimer();
            if (input > 0) {
              lowWasRecalled = false;
              // no one was talking before
              if (lastActiveHighInput === 0) {
                makeCameraSwitch(input, average);
              }
              // the same person is talking
              else if (lastActiveHighInput === input) {
                restartNewSpeakerTimer();
              }
              // a different person is talking
              else if (lastActiveHighInput !== input) {
                if (allowNewSpeaker) {
                  makeCameraSwitch(input, average);
                }
              }
            }
          }
          // no one is speaking
          else if (average < MICROPHONELOW) {
            // only trigger if enough time has elapsed since someone spoke last
            if (allowSideBySide) {
              if (input > 0 && !lowWasRecalled) {
                lastActiveHighInput = 0;
                lowWasRecalled = true;
                console.log("-------------------------------------------------");
                console.log("Low Triggered");
                console.log("-------------------------------------------------");
                recallSideBySideMode();
              }
            }
          }

  }
}

// function to actually switch the camera input
function makeCameraSwitch(input, average) {
  console.log("-------------------------------------------------");
  console.log("High Triggered: ");
  console.log(`Input = ${input} | Average = ${average}`);
  console.log("-------------------------------------------------");
   // Switch to the source that is speficied in the same index position in MAP_CAMERA_SOURCE_IDS
  let sourceDict={ SourceID : '0'}
  sourceDict["SourceID"]=MAP_CAMERA_SOURCE_IDS[CONNECTORS.indexOf(input)].toString();
  console.log("Trying to use this for source dict: ", sourceDict  )
  xapi.command('Video Input SetMainVideoSource', sourceDict).catch(handleError);
  // send required messages to auxiliary codec
  sendIntercodecMessage(AUX_CODEC, 'automatic_mode');
  lastActiveHighInput = input;
  restartNewSpeakerTimer();
}

function largestMicValue() {
  // figure out which of the inputs has the highest average level and return the corresponding key
 let currentMaxValue=0;
 let currentMaxKey='';
 let theAverage=0;
 for (var i in CONNECTORS){
    theAverage=averageArray(micArrays[CONNECTORS[i].toString()]);
    if (theAverage>=currentMaxValue) {
        currentMaxKey=CONNECTORS[i].toString();
        currentMaxValue=theAverage;
    }
 }
 return currentMaxKey;
}

function averageArray(arrayIn) {
  let sum = 0;
  for(var i = 0; i < arrayIn.length; i++) {
    sum = sum + parseInt( arrayIn[i], 10 );
  }
  let avg = (sum / arrayIn.length) * arrayIn.length;
  return avg;
}

function recallSideBySideMode() {
  if (overviewShowDouble) {
        let connectorDict={ ConnectorId : [0,0]};
        connectorDict["ConnectorId"]=OVERVIEW_DOUBLE_SOURCE_IDS;
        console.log("Trying to use this for connector dict in recallSideBySideMode(): ", connectorDict  )
        xapi.command('Video Input SetMainVideoSource', connectorDict).catch(handleError);
        xapi.command('Cameras SpeakerTrack Deactivate').catch(handleError);
        xapi.command('Camera Preset Activate', { PresetId: 30 }).catch(handleError);
    }
    else {
        let sourceDict={ SourceID : '0'};
        sourceDict["SourceID"]=OVERVIEW_SINGLE_SOURCE_ID.toString();
        console.log("Trying to use this for source dict in recallSideBySideMode(): ", sourceDict  )
        xapi.command('Video Input SetMainVideoSource', sourceDict).catch(handleError);
    }
  // send required messages to other codecs
  sendIntercodecMessage(AUX_CODEC, 'side_by_side');
  lastActiveHighInput = 0;
  lowWasRecalled = true;
}


/////////////////////////////////////////////////////////////////////////////////////////
// TOUCH 10 UI FUNCTION HANDLERS
/////////////////////////////////////////////////////////////////////////////////////////

function handleOverrideWidget(event)
{
         if (event.WidgetId === 'widget_override')
         {
            console.log("Camera Control button selected.....")
            if (event.Value === 'off') {

                    console.log("Camera Control is set to Manual...");
                    console.log("Stopping automation...")
                    stopAutomation();
                }
               else
               {

                  // start VuMeter monitoring
                  console.log("Camera Control is set to Automatic...");
                  console.log("Starting automation...")
                  startAutomation();
               }
         }


         if (event.WidgetId === 'widget_FS_selfview')
         {
            console.log("Selfview button selected.....")
            if (event.Value === 'off') {
                    console.log("Selfview is set to Off...");
                    console.log("turning off self-view...")
                    xapi.Command.Video.Selfview.Set({ FullscreenMode: 'Off', Mode: 'Off', OnMonitorRole: 'First'});
                }
               else
               {
                  console.log("Selfview is set to On...");
                  console.log("turning on self-view...")
                  // TODO: determine if turning off self-view should also turn off fullscreenmode
                  xapi.Command.Video.Selfview.Set({ FullscreenMode: 'On', Mode: 'On', OnMonitorRole: 'First'});
               }
         }
}


/////////////////////////////////////////////////////////////////////////////////////////
// ERROR HANDLING
/////////////////////////////////////////////////////////////////////////////////////////

function handleError(error) {
  console.log(error);
}

/////////////////////////////////////////////////////////////////////////////////////////
// INTER-CODEC COMMUNICATION
/////////////////////////////////////////////////////////////////////////////////////////

function sendIntercodecMessage(codec, message) {
  if (codec.enable) {
    console.log(`sendIntercodecMessage: codec = ${codec.url} | message = ${message}`);

    let url = 'https://' + codec.url + '/putxml';
    
    let headers = [
      'Content-Type: text/xml',
      'Authorization: Basic ' + codec.auth
    ];

    let payload = "<XmlDoc internal='True'><Command><Message><Send><Text>"+ message +"</Text></Send></Message></Command></XmlDoc>";
    let errMessage1="Error connecting to second camera, please contact the Administrator";
    let errMessage2="Second camera is offline, please contact the Administrator";
    xapi.command('HttpClient Post', {Url: url, Header: headers, AllowInsecureHTTPS: 'True'}, payload)
      .then((response) => {
            if(response.StatusCode === "200") {
                console.log("Successfully sent: " + payload)
            }
            else {
                console.log("Error "+response.StatusCode+" sending message to Aux: ",response.StatusCode);
                alertFailedIntercodecComm(errMessage1);
            }
        })
      .catch((err) => {
        if ("data" in err) {
          console.log("Sending message failed: "+err.message+" Status code: "+err.data.StatusCode);
        } else {
          console.log("Sending message failed: "+err.message);
        }
        alertFailedIntercodecComm(errMessage2);
      });
  };
}

function alertFailedIntercodecComm(message) {
        xapi.command("UserInterface Message Alert Display", {
        Text: message
      , Duration: 10
    }).catch((error) => { console.error(error); });
}

/////////////////////////////////////////////////////////////////////////////////////////
// OTHER FUNCTIONAL HANDLERS
/////////////////////////////////////////////////////////////////////////////////////////


function handleMicMuteOn() {
  console.log('handleMicMuteOn');
  lastActiveHighInput = 0;
  lowWasRecalled = true;
  recallSideBySideMode();
}

function handleMicMuteOff() {
  console.log('handleMicMuteOff');
  // need to turn back on SpeakerTrack that might have been turned off when going on mute
  xapi.command('Cameras SpeakerTrack Activate').catch(handleError);
}

// ---------------------- MACROS

function handleMessage(event) {
  switch(event.Text) {
    case "VTC-1_OK":
      handleCodecOnline(AUX_CODEC);
      break;
  }
}

// function to check the satus of the macros running on the AUX codec
function handleMacroStatus() {
  console.log('handleMacroStatus');
  // reset tracker of responses from AUX codec
  AUX_CODEC.online = false;
  // send required messages to AUX codec
  sendIntercodecMessage(AUX_CODEC, 'VTC-1_status');
}

function handleCodecOnline(codec) {
  console.log(`handleCodecOnline: codec = ${codec.url}`);
  codec.online = true;
}

function handleWakeUp() {
  console.log('handleWakeUp');
  // stop automatic switching behavior
  stopAutomation();
  // send wakeup to AUX codec
  sendIntercodecMessage(AUX_CODEC, 'wake_up');
  // check the satus of the macros running on the AUX codec and store it in AUX_CODEC.online
  // in case we need to check it in some other function
  handleMacroStatus();
}

function handleShutDown() {
  console.log('handleShutDown');
  // send required messages to other codecs
  sendIntercodecMessage(AUX_CODEC, 'shut_down');
}

/////////////////////////////////////////////////////////////////////////////////////////
// VARIOUS TIMER HANDLER FUNCTIONS
/////////////////////////////////////////////////////////////////////////////////////////

function startSideBySideTimer() {
  if (sideBySideTimer == null) {
    allowSideBySide = false;
    sideBySideTimer = setTimeout(onSideBySideTimerExpired, SIDE_BY_SIDE_TIME);
  }
}

function stopSideBySideTimer() {
  if (sideBySideTimer != null) {
    clearTimeout(sideBySideTimer);
    sideBySideTimer = null;
  }
}

function restartSideBySideTimer() {
  stopSideBySideTimer();
  startSideBySideTimer();
}

function onSideBySideTimerExpired() {
  console.log('onSideBySideTimerExpired');
  allowSideBySide = true;
  recallSideBySideMode();
}



function startInitialCallTimer() {
  if (InitialCallTimer == null) {
    allowCameraSwitching = false;
    InitialCallTimer = setTimeout(onInitialCallTimerExpired, INITIAL_CALL_TIME);
  }
}

function onInitialCallTimerExpired() {
  console.log('onInitialCallTimerExpired');
  allowCameraSwitching = true;
  xapi.command('Cameras SpeakerTrack Activate').catch(handleError);

}

function startNewSpeakerTimer() {
  if (newSpeakerTimer == null) {
    allowNewSpeaker = false;
    newSpeakerTimer = setTimeout(onNewSpeakerTimerExpired, NEW_SPEAKER_TIME);
  }
}

function stopNewSpeakerTimer() {
  if (newSpeakerTimer != null) {
    clearTimeout(newSpeakerTimer);
    newSpeakerTimer = null;
  }
}

function restartNewSpeakerTimer() {
  stopNewSpeakerTimer();
  startNewSpeakerTimer();
}

function onNewSpeakerTimerExpired() {
  allowNewSpeaker = true;
}

/////////////////////////////////////////////////////////////////////////////////////////
// INVOCATION OF INIT() TO START THE MACRO
/////////////////////////////////////////////////////////////////////////////////////////

init();