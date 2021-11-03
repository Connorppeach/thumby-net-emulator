class ReplJS{
    constructor(){
        this.PORT = undefined;      // Reference to serial port
        this.READER = undefined;    // Reference to serial port reader, only one can be locked at a time
        this.WRITER = undefined;    // Reference to serial port writer, only one can be locked at a time

        this.TEXT_ENCODER = new TextEncoder();  // Used to write text to MicroPython
        this.TEXT_DECODER = new TextDecoder();  // Used to read text from MicroPython

        this.USB_VENDOR_ID = 11914; // For filtering ports during auto or manual selection
        this.USB_PRODUCT_ID = 5;    // For filtering ports during auto or manual selection

        // https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L444 need to only send 256 bytes each time
        this.THUMBY_SEND_BLOCK_SIZE = 255;  // How many bytes to send to Thumby at a time when uploading a file to it

        // Set true so most terminal output gets passed to javascript terminal
        this.DEBUG_CONSOLE_ON = true;

        this.COLLECT_RAW_DATA = false;
        this.COLLECTED_RAW_DATA = [];

        // Used to stop interaction with the RP2040
        this.BUSY = false;

        // ### CALLBACKS ###
        // Functions defined outside this module but used inside
        this.onData = undefined;
        this.onConnect = undefined;
        this.onDisconnect = undefined;
        this.onFSData = undefined;

        // ### MicroPython Control Commands ###
        // DOCS: https://docs.micropython.org/en/latest/esp8266/tutorial/repl.html#other-control-commands
        // UNICODE CTRL CHARS COMBOS: https://unicodelookup.com/#ctrl
        this.CTRL_CMD_RAWMODE = "\x01";     // ctrl-A (use for wating to get file information, upload files, run custom python tool, etc)
        this.CTRL_CMD_NORMALMODE = "\x02";  // ctrl-B (user friendly terminal)
        this.CTRL_CMD_KINTERRUPT = "\x03";  // ctrl-C (stops a running program)
        this.CTRL_CMD_SOFTRESET = "\x04";   // ctrl-D (soft reset the board, required after a command is entered in raw!)
        this.CTRL_CMD_PASTEMODE = "\x05";

        this.SPECIAL_FORCE_OUTPUT_FLAG = false;

        // Use to disable auto connect if manual connecting in progress
        this.MANNUALLY_CONNECTING = false;

        this.READ_UNTIL_STRING = "";    // Set to something not "" to halt until this.READ_UNTIL_STRING found and collect lines in this.COLLECTED_DATA
        this.COLLECTED_DATA = "";

        // Check if browser can use WebSerial
        if ("serial" in navigator) {
            if(this.DEBUG_CONSOLE_ON) console.log("Serial supported in this browser!");
        } else {
            alert("Serial NOT supported in your browser! Use Microsoft Edge or Google Chrome");
            return;
        }

        
        // Attempt auto-connect when page validated device plugged in, do not start manual selection menu
        navigator.serial.addEventListener('connect', (e) => {
            if(this.MANNUALLY_CONNECTING  == false){
                this.tryAutoConnect();
            }
        });

        
        // Probably set flags/states when page validated device removed
        navigator.serial.addEventListener('disconnect', (e) => {
            var disconnectedPort = e.target;

            // Only display disconnect message if there is a matching port on auto detect or not already disconnected
            if(this.checkPortMatching(disconnectedPort) && this.DISCONNECT == false){
                if(this.DEBUG_CONSOLE_ON) console.log("%cDisconnected MicroPython!", "color: yellow");
                this.WRITER = undefined;
                this.READER = undefined;
                this.PORT = undefined;
                this.DISCONNECT = true; // Will stop certain events and break any EOT waiting functions
                this.onDisconnect();
                this.BUSY = false;      // If not set false here, if disconnected at just the right time, can't connect until refresh
            }
        });

        document.getElementById("IDConnectThumbyBTN").addEventListener("click", (event) => {
            this.connect();
        })

        this.DISCONNECT = true;
    }


    // Returns tru if product and vendor ID match for MicroPython, otherwise false #
    checkPortMatching(port){
        var info = port.getInfo();
        if(info.usbProductId == this.USB_PRODUCT_ID && info.usbVendorId == this.USB_VENDOR_ID){
            return true;
        }
        return false;
    }


    startCollectRawData(){
        this.COLLECT_RAW_DATA = true;
        this.COLLECTED_RAW_DATA = [];
    }

    endCollectRawData(){
        this.COLLECT_RAW_DATA = false;
    }


    startReaduntil(str){
        this.READ_UNTIL_STRING = str;
        this.COLLECTED_DATA = "";
    }


    // Wait until an OK is received, else write ctrl-c since raw sometimes gets stuck? Seems to work for upload files
    async waitUntilOK(){
        var times = 0;

        while (this.DISCONNECT == false) {
            var tempLines = this.COLLECTED_DATA.split('\r\n');

            for(var i=0; i<tempLines.length; i++){
                if(tempLines[i] == "OK" || tempLines[i] == ">"){
                    return;
                }
            }

            times = times + 1;
            if(times >= 15){
                this.writeToDevice('');
                console.error("Had to use ugly hack for hanging raw prompt...");
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }


    // Will stall js until finds line set by startReaduntil().
    // Providing an offset will skip subsequent lines after the
    // found line set by startReaduntil.
    // Loops forever if never finds line set by startReaduntil()
    async haltUntilRead(omitOffset = 0){

        // Re-evaluate collected data for readUntil line every 85ms
        while (this.DISCONNECT == false) {
            var tempLines = this.COLLECTED_DATA.split('\r\n');

            for(var i=0; i<tempLines.length; i++){
                if(tempLines[i] == this.READ_UNTIL_STRING || this.READ_UNTIL_STRING == "" || tempLines[i].indexOf(this.READ_UNTIL_STRING) != -1
                  || tempLines[i] == ">"){ // Keyboard interrupt
                    this.READ_UNTIL_STRING = "";

                    // Output the rest of the lines that should not be hidden
                    // Should find a way to do this without adding newlines again
                    for(var j=i+omitOffset; j<tempLines.length; j++){
                        if(j != tempLines.length-1){
                            this.onData(tempLines[j] + "\r\n");
                        }else{
                            this.onData(tempLines[j]);
                        }
                    }

                    return tempLines.slice(0, i+omitOffset);    // Return all lines collected just before the line that switched off haltUntil()
                }
            }
            await new Promise(resolve => setTimeout(resolve, 85));
        }
    }


    async readLoop(){
        // Everytime the readloop is started means a device was connect/reconnected, reset variables states in case of reconnect
        this._CHUNKS = "";

        while (this.PORT != undefined && this.PORT.readable && this.DISCONNECT == false) {
            // Check if reader locked (can be locked if try to connect again and port was already open but reader wasn't released)
            if(!this.PORT.readable.locked){
                this.READER = this.PORT.readable.getReader();
            }
            
            try {
                while (true) {
                    // https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/read
                    const { value, done } = await this.READER.read();
                    if (done) {
                        // Allow the serial port to be closed later.
                        this.READER.releaseLock();
                        break;
                    }
                    if (value) {
                        // Reading from serial is done in chunks of a inconsistent/non-guaranteed size,
                        if(this.DEBUG_CONSOLE_ON) console.log(this.TEXT_DECODER.decode(value));

                        // Collect lines when read until active, otherwise, output to terminal
                        if(this.READ_UNTIL_STRING == ""){
                            this.onData(this.TEXT_DECODER.decode(value));
                        }else{
                            if(this.SPECIAL_FORCE_OUTPUT_FLAG){
                                this.onData(this.TEXT_DECODER.decode(value));
                            }
                            this.COLLECTED_DATA += this.TEXT_DECODER.decode(value);

                            // If raw flag set true, collect raw data for now
                            if(this.COLLECT_RAW_DATA == true){
                                for(var i=0; i<value.length; i++){
                                    this.COLLECTED_RAW_DATA.push(value[i]);
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                // TODO: Handle non-fatal read error.
                if(err.name == "NetworkError"){
                    if(this.DEBUG_CONSOLE_ON) console.log("%cDevice most likely unplugged, handled", "color: yellow");
                }
            }
        }
        if(this.DEBUG_CONSOLE_ON) console.log("%cCurrent read loop ended!", "color: yellow");
        this.BUSY = false;
    }


    async writeToDevice(str){
        if(this.WRITER != undefined){
            await this.WRITER.write(this.TEXT_ENCODER.encode(str));
        }else{
            if(this.DEBUG_CONSOLE_ON) console.log("%cNot writing to device, none connected", "color: red");
        }
    }

    async softReset(){
        this.startReaduntil("MPY: soft reboot");
        await this.writeToDevice(this.CTRL_CMD_SOFTRESET);
        await this.haltUntilRead(4);
    }

    // https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L325
    async getToNormal(omitOffset = 0){
        await this.getToRaw();  // Get to raw first so that unwanted messages are not printed (like another intro message)

        this.startReaduntil("Raspberry Pi Pico with RP2040");
        // https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L360 for "\r"
        await this.writeToDevice("\r" + this.CTRL_CMD_NORMALMODE);
        await this.haltUntilRead(omitOffset);
    }

    async getToRaw(){
        this.startReaduntil("raw REPL; CTRL-B to exit");
        // Refer to pyboard.py for "\r" https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L326-L334
        await this.writeToDevice("\r" + this.CTRL_CMD_KINTERRUPT + this.CTRL_CMD_KINTERRUPT);  // ctrl-C twice: interrupt any running program
        await this.writeToDevice("\r" + this.CTRL_CMD_RAWMODE);
        await this.haltUntilRead(2);

        await this.softReset();
    }


    // Goes into raw mode and writes a command according to the THUMBY_SEND_BLOCK_SIZE then executes
    async writeUtilityCmdRaw(cmdStr, waitForCmdEnd = false, omitAmount = 0, customWaitForStr = ">"){
        // Get into raw mode
        await this.getToRaw();

        // Send the cmd string
        var numberOfChunks = Math.ceil(cmdStr.length/this.THUMBY_SEND_BLOCK_SIZE)+1;
        for(var b=0; b < numberOfChunks; b++){
            var writeDataCMD = cmdStr.slice(b*this.THUMBY_SEND_BLOCK_SIZE, (b+1)*this.THUMBY_SEND_BLOCK_SIZE);
            console.log(writeDataCMD);
            await this.writeToDevice(writeDataCMD);
        }


        if(waitForCmdEnd){
            this.startReaduntil(customWaitForStr);
            await this.writeToDevice("\x04");
            if(customWaitForStr == ">") await this.waitUntilOK();
            return await this.haltUntilRead(omitAmount);
        }else{
            await this.writeToDevice("\x04");
        }
    }


    async getOnBoardFSTree(){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd = "import os\n" +
        "import ujson\n" +
        
        "def walk(top, structure, dir):\n" +
        
        "    extend = \"\";\n" +
        "    if top != \"\":\n" + 
        "        extend = extend + \"/\"\n" +
                
        "    item_index = 0\n" +
        "    structure[dir] = {}\n" +
            
        "    # Loop through and create stucture of on-board FS\n" +
        "    for dirent in os.listdir(top):\n" +
        "        if(os.stat(top + extend + dirent)[0] == 32768):\n" +   // File
        "            structure[dir][item_index] = {\"F\": dirent}\n" +
        "            item_index = item_index + 1\n" +
        "        elif(os.stat(top + extend + dirent)[0] == 16384):\n" + // Dir
        "            structure[dir][item_index] = {\"D\": dirent}\n" +
        "            item_index = item_index + 1\n" +
        "            walk(top + extend + dirent, structure[dir], dirent)\n" +
        "    return structure\n" +
        "struct = {}\n" +
        "print(ujson.dumps(walk(\"\", struct, \"\")))\n";

        var hiddenLines = await this.writeUtilityCmdRaw(cmd, true, 1);

        // Make sure this wasn't executed when no Thumby was attached
        if(hiddenLines != undefined){
            this.onFSData(hiddenLines[0].substring(2));
        }

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;
    }


    async executeLines(lines){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        // Get into raw mode
        await this.getToRaw();

        // Not really needed for hiding output to terminal since raw does not echo
        // but is needed to only grab the FS lines/data
        this.startReaduntil(">");
        await this.writeToDevice(lines + "\x04");
        await this.waitUntilOK();
        this.SPECIAL_FORCE_OUTPUT_FLAG = true;
        await this.haltUntilRead(1);

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        this.SPECIAL_FORCE_OUTPUT_FLAG = false;
        await this.getToRaw();
        this.SPECIAL_FORCE_OUTPUT_FLAG = true;

        this.startReaduntil("Raspberry Pi Pico with RP2040");
        await this.writeToDevice("\r" + this.CTRL_CMD_NORMALMODE);
        await this.haltUntilRead(3);
        this.BUSY = false;
        

        // Make sure to update the filesystem after modifying it
        this.SPECIAL_FORCE_OUTPUT_FLAG = false;
        await this.getOnBoardFSTree();
    }


    // Given a path, delete it on RP2040
    async deleteFileOrDir(path){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        window.setPercent(1, "Deleting...");
        var cmd =   "import os\n" +
                    "def rm(d):  # Remove file or tree\n" +
                    "   try:\n" +
                    "       if os.stat(d)[0] & 0x4000:  # Dir\n" +
                    "           for f in os.ilistdir(d):\n" +
                    "               if f[0] not in ('.', '..'):\n" +
                    "                   rm('/'.join((d, f[0])))  # File or Dir\n" +
                    "           os.rmdir(d)\n" +
                    "       else:  # File\n" +
                    "           os.remove(d)\n" +
                    "       print('rm_worked')\n" +
                    "   except:\n" +
                    "       print('rm_failed')\n" +
                    "rm('" + path + "')\n";


        window.setPercent(2);
        await this.writeUtilityCmdRaw(cmd, true, 1);
        window.setPercent(55);

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;

        // Make sure to update the filesystem after modifying it
        await this.getOnBoardFSTree();
        window.setPercent(100);
        window.resetPercentDelay();
    }


    // Sends commands to RP2040 to rename file at given path to provided new name
    async renameFile(oldPath, newName){
        if(oldPath != undefined && newName != undefined && newName != null && newName != ""){
            if(this.BUSY == true){
                return;
            }
            this.BUSY = true;
            window.setPercent(1, "Renaming file...");

            var newPath = oldPath.substring(0, oldPath.lastIndexOf("/")+1) + newName;
            var cmd =   "import uos\n" +
                        "exists = 1\n" +
                        "try:\n" +
                        "   f = open('" + newPath + "', 'r')\n" +
                        "   exists = 1\n" +
                        "   f.close()\n" +
                        "except  OSError:\n" +
                        "   exists = 0\n" +
                        "if exists == 0:\n" +
                        "   uos.rename('" + oldPath + "', '" + newPath +"')\n" +
                        "   print('no_rename_error')\n" +
                        "else:\n" +
                        "   print('rename_error')\n";
            
            window.setPercent(2);
            await this.writeUtilityCmdRaw(cmd, true, 1);
            window.setPercent(55);

            // Get back into normal mode and omit the 3 lines from the normal message,
            // don't want to repeat (assumes already on a normal prompt)
            await this.getToNormal(3);
            this.BUSY = false;

            // Make sure to update the filesystem after modifying it
            await this.getOnBoardFSTree();
            window.setPercent(100);
            window.resetPercentDelay();
        }
    }


    async downloadFile(filePath) {
        let response = await fetch(filePath);
            
        if(response.status != 200) {
            throw new Error("Server Error");
        }
            
        // read response stream as text
        let text_data = await response.text();

        return text_data;
    }


    async deleteAllFiles(){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd =   "import os\n" +
                    "def rm(d):  # Remove file or tree\n" +
                    "   try:\n" +
                    "       if os.stat(d)[0] & 0x4000:  # Dir\n" +
                    "           for f in os.ilistdir(d):\n" +
                    "               if f[0] not in ('.', '..'):\n" +
                    "                   rm('/'.join((d, f[0])))  # File or Dir\n" +
                    "           os.rmdir(d)\n" +
                    "       else:  # File\n" +
                    "           os.remove(d)\n" +
                    "       print('rm_worked')\n" +
                    "   except:\n" +
                    "       print('rm_failed')\n" +
                    "filelist = os.listdir('/')\n" +
                    "for f in filelist:\n" +
                    "    rm('/' + f)\n";

        await this.writeUtilityCmdRaw(cmd, true, 1);

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;
    }


    async buildPath(path){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        // Got through and make sure entire path already exists
        var cmd = "import uos\n" +
                  "try:\n" +
                  "    path = '" + path + "'\n" +
                  "    path = path.split('/')\n" +
                  "    builtPath = path[0]\n" +
                  "    for i in range(1, len(path)+1):\n" +
                  "        try:\n" +
                  "            uos.mkdir(builtPath)\n" +
                  "        except OSError:\n" +
                  "            print('Directory already exists, did not make a new folder')\n" +
                  "        if i < len(path):\n" +
                  "            builtPath = builtPath + '/' + path[i]\n" +
                  "except Exception as err:\n" +
                  "    print('Some kind of error while building path...' + err)\n";

        await this.writeUtilityCmdRaw(cmd, true, 1);

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);

        this.BUSY = false;
    }


    async uploadFile(filePath, fileContents, usePercent = false, binaryFile = false){
        if(this.BUSY == true){
            return true;
        }


        // Sometimes newlines are incorrect even though they look correct in ace?
        if(binaryFile == false){
            var fileContents = fileContents.split(/\r\n|\n|\r/);
        
            // Recombine everything with correct newlines
            var combined = "";
            for(var row=0; row<fileContents.length; row++){
                // Make sure not to add an extra newline at end
                if(row != fileContents.length - 1){
                    combined = combined + fileContents[row] + "\n";
                }else{
                    combined = combined + fileContents[row];
                }
            }
            fileContents = combined;
        }


        var pathToFile = filePath.substring(0, filePath.lastIndexOf('/'));
        await this.buildPath(pathToFile);

        this.BUSY = true;
        if(usePercent) window.setPercent(1, "Uploading file...");

        await this.getToRaw();
        if(usePercent) window.setPercent(2);
        // this.startReaduntil(">");


        var bytes = new Uint8Array(fileContents.length);
        if(binaryFile == false){
            for(var i=0; i<bytes.length; i++){
                bytes[i] = fileContents[i].charCodeAt();
            }
        }else{
            bytes = fileContents;
        }


        if(bytes.length >= 2000000){
            alert("This file is at least 2MB, too large, not uploading");
            return;
        }


        // https://forum.micropython.org/viewtopic.php?t=10659&p=58710
        var writeFileScript =   "import micropython\n" +
                                "import sys\n" +
                                "import time\n" +
                                "micropython.kbd_intr(-1)\n" +
                                "w = open('" + filePath + "','wb')\n" +

                                "byte_count_to_read = -1\n" +
                                "read_byte_count = -7\n" +
                                "read_buffer = bytearray(255)\n" +
                                "specialStartIndex = 0\n" +
                                "specialEndIndex = 255\n" +
                                "while True:\n" +
                                "    read_byte_count = read_byte_count + sys.stdin.buffer.readinto(read_buffer, 255)\n" +

                                "    if byte_count_to_read == -1:\n" +
                                "        byte_count_to_read = int(read_buffer[0:7].decode('utf-8'))\n" +
                                "        specialIndex = 7\n" +

                                "    if read_byte_count >= byte_count_to_read:\n" +
                                "        specialEndIndex = 255 - (read_byte_count - byte_count_to_read)\n" +
                                "        read_byte_count = read_byte_count - 255 + specialEndIndex\n" +

                                "    w.write(bytearray(read_buffer[specialIndex:specialEndIndex]))\n" +
                                "    specialIndex = 0\n" +
                                // "    print(read_byte_count)\n" +
                                // "    sys.stdout.write('EOF')\n" +
                                "    if read_byte_count >= byte_count_to_read:\n" +
                                "        break\n" +
                                "w.close()\n" +

                                "micropython.kbd_intr(0x03)\n";


        await this.writeUtilityCmdRaw(writeFileScript, true, 1, "OK");

        // https://stackoverflow.com/a/1127966
        var bytesLenStr = "" + bytes.length;
        while (bytesLenStr.length < 7) {
            bytesLenStr = "0" + bytesLenStr;
        }
        await this.writeToDevice(bytesLenStr);


        if(usePercent) window.setPercent(3);

        var numberOfChunks = Math.ceil(bytes.length/this.THUMBY_SEND_BLOCK_SIZE)+1;
        var currentPercent = 3;
        var endingPercent = 98;
        var percentStep = (endingPercent - currentPercent) / numberOfChunks;


        var bytesSent = 0;
        for(var b=0; b < numberOfChunks; b++){
            var writeDataCMD = bytes.slice(b*this.THUMBY_SEND_BLOCK_SIZE, (b+1)*this.THUMBY_SEND_BLOCK_SIZE);
        
            bytesSent = bytesSent + writeDataCMD.length;

            if(bytesSent == bytes.length && writeDataCMD.length < this.THUMBY_SEND_BLOCK_SIZE){
                var fillerArray = new Uint8Array(this.THUMBY_SEND_BLOCK_SIZE - writeDataCMD.length);
                for(var i = 0; i < fillerArray.length; i++){
                    fillerArray[i] = 255;
                }

                var finalArray = new Uint8Array(writeDataCMD.length + fillerArray.length);
                finalArray.set(writeDataCMD, 0);
                finalArray.set(fillerArray, writeDataCMD.length);
                writeDataCMD = finalArray;
            }

            if(this.WRITER != undefined){
                // this.startReaduntil("EOF");
                await this.WRITER.write(writeDataCMD);
                console.log("Sent file chunk: " + b);
                // await this.haltUntilRead(0);
            }else{
                if(this.DEBUG_CONSOLE_ON) console.log("%cNot writing to device, none connected", "color: red");
            }

            currentPercent = currentPercent + percentStep;
            if(usePercent) window.setPercent(currentPercent);
        }

        // await this.haltUntilRead(1);
        await this.getToNormal(3);
        this.BUSY = false;
    }


    async format(){
        window.setPercent(1, "Formatting Thumby...");
        await this.deleteAllFiles();
        await this.getOnBoardFSTree();

        await this.uploadFile("Games/SpaceDebris/SpaceDebris.py", await window.downloadFile("/ThumbyGames/Games/SpaceDebris/SpaceDebris.py"), false, false);
        window.setPercent(11.1);
        await this.uploadFile("Games/Annelid/Annelid.py", await window.downloadFile("/ThumbyGames/Games/Annelid/Annelid.py"), false, false);
        window.setPercent(22.2);
        await this.uploadFile("Games/Thumgeon/Thumgeon.py", await window.downloadFile("/ThumbyGames/Games/Thumgeon/Thumgeon.py"), false, false);
        window.setPercent(33.3);
        await this.uploadFile("Games/SaurRun/SaurRun.py", await window.downloadFile("/ThumbyGames/Games/SaurRun/SaurRun.py"), false, false);
        window.setPercent(44.4);
        await this.uploadFile("Games/TinyBlocks/TinyBlocks.py", await window.downloadFile("/ThumbyGames/Games/TinyBlocks/TinyBlocks.py"), false, false);
        window.setPercent(55.5);
        await this.uploadFile("lib/ssd1306.py", await window.downloadFile("/ThumbyGames/lib/ssd1306.py"), false, false);
        window.setPercent(66.6);
        await this.uploadFile("lib/thumby.py", await window.downloadFile("/ThumbyGames/lib/thumby.py"), false, false);
        window.setPercent(77.7);
        await this.uploadFile("main.py", await window.downloadFile("/ThumbyGames/main.py"), false, false);
        window.setPercent(88.8);
        await this.uploadFile("thumby.cfg", await window.downloadFile("/ThumbyGames/thumby.cfg"), false, false);
        window.setPercent(99.9);

        // Make sure to update the filesystem after modifying it
        await this.getOnBoardFSTree();
        window.resetPercentDelay();
    }


    async uploadFiles(path, fileHandles){
        if(this.BUSY == true){
            return;
        }

        for(var i=0; i<fileHandles.length; i++){
            const file = await fileHandles[i].getFile();
            if(file.name.indexOf(".py") != -1 || file.name.indexOf(".txt") != -1 || file.name.indexOf(".text") != -1 || file.name.indexOf(".cfg") != -1){
                await this.uploadFile(path + file.name, await file.text(), false, false);
            }else{
                await this.uploadFile(path + file.name, new Uint8Array(await file.arrayBuffer()), false, true);
            }
        }

        await this.getOnBoardFSTree();
    }


    async getFileContents(filePath, binary = false){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd =   "import sys\n" +
                    "chunk_size = 256\n" +
                    "onboard_file = open('" + filePath + "', 'rb')\n" +
                    "while True:\n" +
                    "    data = onboard_file.read(chunk_size)\n" +
                    "    if not data:\n" +
                    "        break\n" +
                    "    sys.stdout.buffer.write(data)\n" +
                    "onboard_file.close()\n" +
                    "sys.stdout.write('###DONE READING FILE###')\n";

        // Get into raw mode
        await this.getToRaw();

        // Not really needed for hiding output to terminal since raw does not echo
        // but is needed to only grab the FS lines/data
        if(binary) this.startCollectRawData();
        this.startReaduntil("###DONE READING FILE###");
        await this.writeToDevice(cmd + "\x04");

        // fielcontents only used for case of script ascii, otherwise use COLLECTED_RAW_DATA to get raw binary data to save
        var fileContents = undefined;
        if(!binary){
            fileContents = await this.haltUntilRead(2);
            fileContents = fileContents.join('');
            fileContents = fileContents.substring(2, fileContents.length-26);
        }else{
            await this.haltUntilRead(2);
        }

        if(binary) this.endCollectRawData();

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;

        if(!binary){
            return fileContents;
        }else{
            console.log(this.COLLECTED_RAW_DATA.slice(2, this.COLLECTED_RAW_DATA.length-26).length);
            return this.COLLECTED_RAW_DATA.slice(2, this.COLLECTED_RAW_DATA.length-26);
        }
    }


    async openPort(){
        if(this.PORT != undefined){
            this.DISCONNECT = false;
            try{
                await this.PORT.open({ baudRate: 115200 });
                this.WRITER = await this.PORT.writable.getWriter();     // Make a writer since this is the first time port opened
                this.readLoop();                                        // Start read loop

                this.onConnect();
                await this.getToNormal();
                this.BUSY = false;  // Was true from connect()
                await this.getOnBoardFSTree();
                // await this.writeConnectedMessage();

            }catch(err){
                if(err.name == "InvalidStateError"){
                    if(this.DEBUG_CONSOLE_ON) console.log("%cPort already open, everything good to go!", "color: lime");

                    this.onConnect();
                    await this.getToNormal();
                    this.BUSY = false;  // Was true from connect()
                    await this.getOnBoardFSTree();
                    // await this.writeConnectedMessage();
                    
                }else if(err.name == "NetworkError"){
                    if(this.DEBUG_CONSOLE_ON) console.log("%cOpening port failed, is another application accessing this device/port?", "color: red");
                }
            }
        }else{
            console.error("Port undefined!");
        }
    }


    async tryAutoConnect(){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        if(this.DEBUG_CONSOLE_ON) console.log("%cTrying auto connect...", "color: yellow");
        var ports = await navigator.serial.getPorts();
        if(Array.isArray(ports)){
            for(var ip=0; ip<ports.length; ports++){
                if(this.checkPortMatching(ports[ip])){
                    this.PORT = ports[ip];
                    if(this.DEBUG_CONSOLE_ON) console.log("%cAuto connected!", "color: lime");
                    await this.openPort();
                    return true;
                }
            }
        }else{
            if(this.checkPortmatching(ports)){
                this.PORT = ports[ip];
                if(this.DEBUG_CONSOLE_ON) console.log("%cAuto connected!", "color: lime");
                await this.openPort();
                return true;
            }
        }
        if(this.DEBUG_CONSOLE_ON) console.log("%cNot Auto connected...", "color: yellow");

        this.BUSY = false;
        return false;
    }

    
    async connect(){
        if(this.BUSY == true){
            return;
        }

        var autoConnected = await this.tryAutoConnect();
        
        const usbVendorId = this.USB_VENDOR_ID;
        const usbProductId = this.USB_PRODUCT_ID;

        if(!autoConnected){
            this.BUSY = true;
            this.MANNUALLY_CONNECTING = true;
            if(this.DEBUG_CONSOLE_ON) console.log("%cTrying manual connect..", "color: yellow");

            await navigator.serial.requestPort({filters: [{ usbVendorId, usbProductId }]}).then(async (port) => {
                this.PORT = port;
                if(this.DEBUG_CONSOLE_ON) console.log("%cManually connected!", "color: lime");
                await this.openPort();

            }).catch((err) => {
                if(this.DEBUG_CONSOLE_ON) console.log("%cNot manually connected...", "color: yellow");
            });
            this.MANNUALLY_CONNECTING = false;
            this.BUSY = false;
        }
    }


    async disconnect(){
        if(this.PORT != undefined){
            this.DISCONNECT = true;
            this.READER.cancel();
            this.READER.releaseLock();
            this.WRITER.releaseLock();
            this.PORT.close();

            this.READER = undefined;
            this.WRITER = undefined;
            this.PORT = undefined;

            this.onDisconnect();
        }
    }
}