/**
 * @fileoverview Implements the PCx86 ChipSet component.
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @copyright © Jeff Parsons 2012-2017
 *
 * This file is part of PCjs, a computer emulation software project at <http://pcjs.org/>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every modified copy of this work
 * and to display that copyright notice when the software starts running; see COPYRIGHT in
 * <http://pcjs.org/modules/shared/lib/defines.js>.
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of PCjs
 * for purposes of the GNU General Public License, and the author does not claim any copyright
 * as to their contents.
 */

"use strict";

if (NODE) {
    var Str         = require("../../shared/lib/strlib");
    var Usr         = require("../../shared/lib/usrlib");
    var Web         = require("../../shared/lib/weblib");
    var Component   = require("../../shared/lib/component");
    var State       = require("../../shared/lib/state");
    var PCX86       = require("./defines");
    var Interrupts  = require("./interrupts");
    var Messages    = require("./messages");
    var X86         = require("./x86");
}

/**
 * TODO: The Closure Compiler treats ES6 classes as 'struct' rather than 'dict' by default,
 * which would force us to declare all class properties in the constructor, as well as prevent
 * us from defining any named properties.  So, for now, we mark all our classes as 'unrestricted'.
 *
 * @unrestricted
 */
class ChipSet extends Component {
    /**
     * ChipSet(parmsChipSet)
     *
     * The ChipSet component has the following component-specific (parmsChipSet) properties:
     *
     *      model:          eg, "5150", "5160", "5170", "deskpro386" (should be a member of ChipSet.MODELS)
     *      sw1:            8-character binary string representing the SW1 DIP switches (SW1[1-8]); see Switches Overview
     *      sw2:            8-character binary string representing the SW2 DIP switches (SW2[1-8]) (MODEL_5150 only)
     *      sound:          true to enable (experimental) sound support (default); false to disable
     *      scaleTimers:    true to divide timer cycle counts by the CPU's cycle multiplier (default is false)
     *      floppies:       array of floppy drive sizes in Kb (default is "[360, 360]" if no sw1 value provided)
     *      monitor:        none|tv|color|mono|ega|vga (if no sw1 value provided, default is "ega" for 5170, "mono" otherwise)
     *      dateRTC:        optional RTC date/time (in GMT) to use on reset; use the ISO 8601 format; eg: "2014-10-01T08:00:00"
     *
     * As support for IBM-compatible machines grows, we should refrain from adding new model strings (eg, "att6300")
     * and corresponding model checks, and instead add more ChipSet configuration properties, such as:
     *
     *      portPIT1:       0x48 to enable PIT1 at base port 0x48 (as used by COMPAQ_DESKPRO386); default to undefined
     *      chipKBD:        8041 to select 8041 emulation (eg, for ATT_6300); default to 8255 for MODEL_5150/MODEL_5160, 8042 for MODEL_5170
     *
     * @this {ChipSet}
     * @param {Object} parmsChipSet
     */
    constructor(parmsChipSet)
    {
        super("ChipSet", parmsChipSet, Messages.CHIPSET);

        var model = parmsChipSet['model'];

        /*
         * this.model is a numeric version of the 'model' string; when comparing this.model to standard IBM
         * model numbers, you should generally compare (this.model|0) to the target value, which truncates it.
         */
        if (model && !ChipSet.MODELS[model]) {
            Component.notice("Unrecognized ChipSet model: " + model);
        }

        this.model = ChipSet.MODELS[model] || ChipSet.MODEL_5150_OTHER;

        var bSwitches;
        this.aDIPSwitches = [];

        /*
         * SW1 describes the number of floppy drives, the amount of base memory, the primary monitor type,
         * and (on the MODEL_5160) whether or not a coprocessor is installed.  If no SW1 settings are provided,
         * we look for individual 'floppies' and 'monitor' settings and build a default SW1 value.
         *
         * The defaults below select max memory, monochrome monitor (EGA monitor for MODEL_5170), and two floppies.
         * Don't get too excited about "max memory" either: on a MODEL_5150, the max was 64Kb, and on a MODEL_5160,
         * the max was 256Kb.  However, the RAM component is free to install as much base memory as it likes,
         * overriding the SW1 memory setting.
         *
         * Given that the ROM BIOS is hard-coded to load boot sectors @0000:7C00, the minimum amount of system RAM
         * required to boot is therefore 32Kb.  Whether that's actually enough to run any or all versions of PC-DOS is
         * a separate question.  FYI, with only 16Kb, the ROM BIOS will still try to boot, and fail miserably.
         */
        bSwitches = this.parseDIPSwitches(parmsChipSet[ChipSet.CONTROLS.SW1]);
        this.aDIPSwitches[0] = [bSwitches, bSwitches];

        if (bSwitches == null) {
            this.aFloppyDrives = [360, 360];
            var aFloppyDrives = parmsChipSet['floppies'];
            if (aFloppyDrives && aFloppyDrives.length) this.aFloppyDrives = aFloppyDrives;
            this.setDIPSwitches(ChipSet.SWITCH_TYPE.FLOPNUM, this.aFloppyDrives.length);

            var sMonitor = parmsChipSet['monitor'] || (this.model < ChipSet.MODEL_5170? "mono" : "ega");
            this.setDIPSwitches(ChipSet.SWITCH_TYPE.MONITOR, sMonitor);
        }

        /*
         * SW2 describes the number of 32Kb blocks of I/O expansion RAM that's present in the system. The MODEL_5150
         * ROM BIOS only checked/supported the first four switches, so the maximum amount of additional RAM specifiable
         * was 15 * 32Kb, or 480Kb.  So with a 16Kb-64Kb motherboard, the MODEL_5150 ROM BIOS could support a grand
         * total of 544Kb.  With the 64Kb-256Kb motherboard revision, a 5150 could use the first FIVE SW2 switches,
         * allowing for a grand total as high as 640Kb.
         *
         * For MODEL_5160 (PC XT) and up, memory expansion cards had their own switches, and the motherboard
         * SW2 switches for I/O expansion RAM were eliminated.  Instead, the ROM BIOS scans the entire address space
         * (up to 0xA0000) looking for additional memory.  As a result, the only mechanism we provide for adding RAM
         * (above the maximum of 256Kb supported on the motherboard) is the "size" parameter of the RAM component.
         *
         * NOTE: If you use the "size" parameter, you will not be able to dynamically alter the memory configuration;
         * the RAM component will ignore any changes to SW1.
         */
        bSwitches = this.parseDIPSwitches(parmsChipSet[ChipSet.CONTROLS.SW2]);
        this.aDIPSwitches[1] = [bSwitches, bSwitches];

        this.sCellClass = PCX86.CSSCLASS + "-bitCell";

        this.cDMACs = this.cPICs = 1;
        if (this.model >= ChipSet.MODEL_5170) {
            this.cDMACs = this.cPICs = 2;
        }

        this.fScaleTimers = parmsChipSet['scaleTimers'] || false;
        this.sDateRTC = parmsChipSet['dateRTC'];

        /*
         * Here, I'm finally getting around to trying the Web Audio API.  Fortunately, based on what little
         * I know about sound generation, using the API to make the same noises as the IBM PC speaker seems
         * straightforward.
         *
         * To start, we create an audio context, unless the 'sound' parameter has been explicitly set to false.
         */
        this.fSpeaker = false;
        if (parmsChipSet['sound']) {
            this.classAudio = this.contextAudio = null;
            if (window) {
                this.classAudio = window['AudioContext'] || window['webkitAudioContext'];
            }
            if (this.classAudio) {
                this.contextAudio = new this.classAudio();
            } else {
                if (DEBUG) this.log("AudioContext not available");
            }
        }

        /*
         * I used to defer ChipSet's reset() to powerUp(), which then gave us the option of doing either
         * reset() OR restore(), instead of both.  However, on MODEL_5170 machines, the initial CMOS data
         * needs to be created earlier, so that when other components are initializing their state (eg, when
         * HDC calls setCMOSDriveType() or RAM calls addCMOSMemory()), the CMOS will be ready to take their calls.
         */
        this.reset(true);
    }

    /**
     * initBus(cmp, bus, cpu, dbg)
     *
     * @this {ChipSet}
     * @param {Computer} cmp
     * @param {Bus} bus
     * @param {X86CPU} cpu
     * @param {DebuggerX86} dbg
     */
    initBus(cmp, bus, cpu, dbg)
    {
        this.bus = bus;
        this.cpu = cpu;
        this.dbg = dbg;
        this.cmp = cmp;

        this.fpu = cmp.getMachineComponent("FPU");
        this.setDIPSwitches(ChipSet.SWITCH_TYPE.FPU, this.fpu?1:0, true);

        this.kbd = cmp.getMachineComponent("Keyboard");

        /*
         * This divisor is invariant, so we calculate it as soon as we're able to query the CPU's base speed.
         */
        this.nTicksDivisor = (cpu.getBaseCyclesPerSecond() / ChipSet.TIMER_TICKS_PER_SEC);

        bus.addPortInputTable(this, ChipSet.aPortInput);
        bus.addPortOutputTable(this, ChipSet.aPortOutput);

        if (this.model < ChipSet.MODEL_5170) {
            if (this.model != ChipSet.MODEL_ATT_6300) {
                bus.addPortInputTable(this, ChipSet.aPortInput5150);
                bus.addPortOutputTable(this, ChipSet.aPortOutput5150);
            } else {
                bus.addPortInputTable(this, ChipSet.aPortInput6300);
                bus.addPortOutputTable(this, ChipSet.aPortOutput6300);
            }
        } else {
            bus.addPortInputTable(this, ChipSet.aPortInput5170);
            bus.addPortOutputTable(this, ChipSet.aPortOutput5170);
            if (DESKPRO386 && (this.model|0) == ChipSet.MODEL_COMPAQ_DESKPRO386) {
                bus.addPortInputTable(this, ChipSet.aPortInputDeskPro386);
                bus.addPortOutputTable(this, ChipSet.aPortOutputDeskPro386);
            }
        }
        if (DEBUGGER) {
            if (dbg) {
                var chipset = this;
                /*
                 * TODO: Add more "dumpers" (eg, for DMA, RTC, 8042, etc)
                 */
                dbg.messageDump(Messages.PIC, function onDumpPIC() {
                    chipset.dumpPIC();
                });
                dbg.messageDump(Messages.TIMER, function onDumpTimer(asArgs) {
                    chipset.dumpTimer(asArgs);
                });
                if (this.model >= ChipSet.MODEL_5170) {
                    dbg.messageDump(Messages.CMOS, function onDumpCMOS() {
                        chipset.dumpCMOS();
                    });
                }
            }
            cpu.addIntNotify(Interrupts.RTC, this.intBIOSRTC.bind(this));
        }
        this.setReady();
    }

    /**
     * setBinding(sHTMLType, sBinding, control, sValue)
     *
     * @this {ChipSet}
     * @param {string|null} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
     * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "sw1")
     * @param {HTMLElement} control is the HTML control DOM object (eg, HTMLButtonElement)
     * @param {string} [sValue] optional data value
     * @return {boolean} true if binding was successful, false if unrecognized binding request
     */
    setBinding(sHTMLType, sBinding, control, sValue)
    {
        switch (sBinding) {

        case ChipSet.CONTROLS.SW1:
            this.bindings[sBinding] = control;
            this.addDIPSwitches(0, sBinding);
            return true;

        case ChipSet.CONTROLS.SW2:
            if ((this.model|0) == ChipSet.MODEL_5150 || this.model == ChipSet.MODEL_ATT_6300) {
                this.bindings[sBinding] = control;
                this.addDIPSwitches(1, sBinding);
                return true;
            }
            break;

        case ChipSet.CONTROLS.SWDESC:
            this.bindings[sBinding] = control;
            return true;

        default:
            break;
        }
        return false;
    }

    /**
     * powerUp(data, fRepower)
     *
     * @this {ChipSet}
     * @param {Object|null} data
     * @param {boolean} [fRepower]
     * @return {boolean} true if successful, false if failure
     */
    powerUp(data, fRepower)
    {
        if (!fRepower) {
            if (!data) {
                this.reset();
            } else {
                if (!this.restore(data)) return false;
            }
        }
        return true;
    }

    /**
     * powerDown(fSave, fShutdown)
     *
     * @this {ChipSet}
     * @param {boolean} [fSave]
     * @param {boolean} [fShutdown]
     * @return {Object|boolean} component state if fSave; otherwise, true if successful, false if failure
     */
    powerDown(fSave, fShutdown)
    {
        return fSave? this.save() : true;
    }

    /**
     * reset(fHard)
     *
     * @this {ChipSet}
     * @param {boolean} [fHard] true on the initial reset (not a normal "soft" reset)
     */
    reset(fHard)
    {
        /*
         * We propagate the initial DIP switch values to the current DIP switch values on reset;
         * the user is only allowed to tweak the initial values, which require a reset to take effect.
         */
        var i;
        this.updateDIPSwitches();

        /*
         * DMA (Direct Memory Access) Controller initialization
         */
        this.aDMACs = new Array(this.cDMACs);
        for (i = 0; i < this.cDMACs; i++) {
            this.initDMAController(i);
        }

        /*
         * PIC (Programmable Interupt Controller) initialization
         */
        this.aPICs = new Array(this.cPICs);
        this.initPIC(ChipSet.PIC0.INDEX, ChipSet.PIC0.PORT_LO);
        if (this.cPICs > 1) {
            this.initPIC(ChipSet.PIC1.INDEX, ChipSet.PIC1.PORT_LO);
        }

        /*
         * PIT (Programmable Interval Timer) initialization
         *
         * Although the DeskPro 386 refers to the timers in the first PIT as "Timer 1, Counter 0",
         * "Timer 1, Counter 1" and "Timer 1, Counter 2", we're sticking with IBM's nomenclature:
         * TIMER0, TIMER1 and TIMER2.  Which means that we refer to the "counters" in the second PIT
         * as TIMER3, TIMER4 and TIMER5; that numbering also matches their indexes in the aTimers array.
         */
        this.bPIT0Ctrl = null;          // tracks writes to port 0x43
        this.bPIT1Ctrl = null;          // tracks writes to port 0x4B (MODEL_COMPAQ_DESKPRO386 only)
        this.aTimers = new Array((this.model|0) == ChipSet.MODEL_COMPAQ_DESKPRO386? 6 : 3);
        for (i = 0; i < this.aTimers.length; i++) {
            this.initTimer(i);
        }

        /*
         * PPI and other misc ports
         */
        this.bPPIA = null;              // tracks writes to port 0x60, in case PPI_CTRL.A_IN is not set
        this.bPPIB = null;              // tracks writes to port 0x61, in case PPI_CTRL.B_IN is not set
        this.bPPIC = null;              // tracks writes to port 0x62, in case PPI_CTRL.C_IN_LO or PPI_CTRL.C_IN_HI is not set
        this.bPPICtrl = null;           // tracks writes to port 0x63 (eg, 0x99); read-only
        this.bNMI = ChipSet.NMI.DISABLE;// tracks writes to the NMI Mask Register

        if (this.model == ChipSet.MODEL_ATT_6300) {
            this.b8041Status = 0;       // similar to b8042Status (but apparently only bits 0 and 1 are used)
        }

        /*
         * ChipSet state introduced by the MODEL_5170
         */
        if (this.model >= ChipSet.MODEL_5170) {
            /*
             * The 8042 input buffer is treated as a "command byte" when written via port 0x64 and as a "data byte"
             * when written via port 0x60.  So, whenever the KC8042.CMD.WRITE_CMD "command byte" is written to the input
             * buffer, the subsequent command data byte is saved in b8042CmdData.  Similarly, for KC8042.CMD.WRITE_OUTPORT,
             * the subsequent data byte is saved in b8042OutPort.
             *
             * TODO: Consider a UI for the Keyboard INHIBIT switch.  By default, our keyboard is never inhibited
             * (ie, locked).  Also, note that the hardware changes this bit only when new data is sent to b8042OutBuff.
             */
            this.b8042Status = ChipSet.KC8042.STATUS.NO_INHIBIT;
            this.b8042InBuff = 0;
            this.b8042CmdData = ChipSet.KC8042.DATA.CMD.NO_CLOCK;
            this.b8042OutBuff = 0;

            /*
             * TODO: Provide more control over these 8042 "Input Port" bits (eg, the keyboard lock)
             */
            this.b8042InPort = ChipSet.KC8042.INPORT.MFG_OFF | ChipSet.KC8042.INPORT.KBD_UNLOCKED;

            if (this.getDIPMemorySize() >= 512) {
                this.b8042InPort |= ChipSet.KC8042.INPORT.ENABLE_256KB;
            }

            if (this.getDIPVideoMonitor() == ChipSet.MONITOR.MONO) {
                this.b8042InPort |= ChipSet.KC8042.INPORT.MONO;
            }

            if (DESKPRO386 && (this.model|0) == ChipSet.MODEL_COMPAQ_DESKPRO386) {
                this.b8042InPort |= ChipSet.KC8042.INPORT.COMPAQ_NO80387 | ChipSet.KC8042.INPORT.COMPAQ_NOWEITEK;
            }

            this.b8042OutPort = ChipSet.KC8042.OUTPORT.NO_RESET | ChipSet.KC8042.OUTPORT.A20_ON;

            this.abDMAPageSpare = new Array(8);

            this.bCMOSAddr = 0;         // NMI is enabled, since the ChipSet.CMOS.ADDR.NMI_DISABLE bit is not set in bCMOSAddr

            /*
             * Now that we call reset() from the ChipSet constructor, enabling other components to update
             * their own CMOS information as needed, we must distinguish between the initial ("hard") reset
             * and any later ("soft") resets (eg, from powerUp() calls), and make sure the latter preserves
             * existing CMOS information.
             */
            if (fHard) {
                this.abCMOSData = new Array(ChipSet.CMOS.ADDR.TOTAL);
            }

            this.initRTCTime(this.sDateRTC);

            /*
             * initCMOSData() will initialize a variety of "legacy" CMOS bytes, but it will NOT overwrite any memory
             * size or hard drive type information that might have been set, via addCMOSMemory() or setCMOSDriveType().
             */
            this.initCMOSData();
        }

        if (DEBUGGER && MAXDEBUG) {
            /*
             * Arrays for interrupt counts (one count per IRQ) and timer data
             */
            this.acInterrupts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            this.acTimersFired = [0, 0, 0];
            this.acTimer0Counts = [];
        }
    }

    /**
     * initRTCTime(sDate)
     *
     * Initialize the RTC portion of the CMOS registers to match the specified date/time (or if none is specified,
     * the current date/time).  The date/time should be expressed in the ISO 8601 format; eg: "2011-10-10T14:48:00".
     *
     * NOTE: There are two approaches we could take here: always store the RTC bytes in binary, and convert them
     * to/from BCD on-demand (ie, as the simulation reads/writes the CMOS RTC registers); or init/update them in the
     * format specified by CMOS.STATUSB.BINARY (1 for binary, 0 for BCD).  Both approaches require BCD conversion
     * functions, but the former seems more efficient, in part because the periodic calls to updateRTCTime() won't
     * require any conversions.
     *
     * We take the same approach with the CMOS.STATUSB.HOUR24 setting: internally, we always operate in 24-hour mode,
     * but externally, we convert the RTC hour values to the 12-hour format as needed.
     *
     * Thus, all I/O to the RTC bytes must be routed through the getRTCByte() and setRTCByte() functions, to ensure
     * that all the necessary on-demand conversions occur.
     *
     * @this {ChipSet}
     * @param {string} [sDate]
     */
    initRTCTime(sDate)
    {
        /*
         * NOTE: I've already been burned once by a JavaScript library function that did NOT treat an undefined
         * parameter (ie, a parameter === undefined) the same as an omitted parameter (eg, the async parameter in
         * xmlHTTP.open() in IE), so I'm taking no chances here: if sDate is undefined, then explicitly call Date()
         * with no parameters.
         */
        var date = sDate? new Date(sDate) : new Date();

        /*
         * Example of a valid Date string:
         *
         *      2014-10-01T08:00:00 (interpreted as GMT, resulting in "Wed Oct 01 2014 01:00:00 GMT-0700 (PDT)")
         *
         * Examples of INVALID Date strings:
         *
         *      2014-10-01T08:00:00PST
         *      2014-10-01T08:00:00-0700 (actually, this DOES work in Chrome, but NOT in Safari)
         *
         * In the case of INVALID Date strings, the Date object is invalid, but there's no obvious test for an "invalid"
         * object, so I've adapted the following test from StackOverflow.
         *
         * See http://stackoverflow.com/questions/1353684/detecting-an-invalid-date-date-instance-in-javascript
         */
        if (Object.prototype.toString.call(date) !== "[object Date]" || isNaN(date.getTime())) {
            date = new Date();
            this.println("CMOS date invalid (" + sDate + "), using " + date);
        } else if (sDate) {
            this.println("CMOS date: " + date);
        }

        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_SEC] = date.getSeconds();
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_SEC_ALRM] = 0;
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MIN] = date.getMinutes();
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MIN_ALRM] = 0;
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_HOUR] = date.getHours();
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_HOUR_ALRM] = 0;
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_WEEK_DAY] = date.getDay() + 1;
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH_DAY] = date.getDate();
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH] = date.getMonth() + 1;
        var nYear = date.getFullYear();
        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_YEAR] = nYear % 100;
        var nCentury = (nYear / 100);
        this.abCMOSData[ChipSet.CMOS.ADDR.CENTURY_DATE] = (nCentury % 10) | ((nCentury / 10) << 4);

        this.abCMOSData[ChipSet.CMOS.ADDR.STATUSA] = 0x26;                          // hard-coded default; refer to ChipSet.CMOS.STATUSA.DV and ChipSet.CMOS.STATUSA.RS
        this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] = ChipSet.CMOS.STATUSB.HOUR24;   // default to BCD mode (ChipSet.CMOS.STATUSB.BINARY not set)
        this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] = 0x00;
        this.abCMOSData[ChipSet.CMOS.ADDR.STATUSD] = ChipSet.CMOS.STATUSD.VRB;

        this.nRTCCyclesLastUpdate = this.nRTCCyclesNextUpdate = 0;
        this.nRTCPeriodsPerSecond = this.nRTCCyclesPerPeriod = null;
    }

    /**
     * getRTCByte(iRTC)
     *
     * @param {number} iRTC
     * @return {number} b
     */
    getRTCByte(iRTC)
    {
        this.assert(iRTC >= 0 && iRTC <= ChipSet.CMOS.ADDR.STATUSD);

        var b = this.abCMOSData[iRTC];

        if (iRTC < ChipSet.CMOS.ADDR.STATUSA) {
            var f12HourValue = false;
            if (iRTC == ChipSet.CMOS.ADDR.RTC_HOUR || iRTC == ChipSet.CMOS.ADDR.RTC_HOUR_ALRM) {
                if (!(this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.HOUR24)) {
                    if (b < 12) {
                        b = (!b? 12 : b);
                    } else {
                        b -= 12;
                        b = (!b? 0x8c : b + 0x80);
                    }
                    f12HourValue = true;
                }
            }
            if (!(this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.BINARY)) {
                /*
                 * We're in BCD mode, so we must convert b from BINARY to BCD.  But first:
                 *
                 *      If b is a 12-hour value (ie, we're in 12-hour mode) AND the hour is a PM value
                 *      (ie, in the range 0x81-0x8C), then it must be adjusted to yield 81-92 in BCD.
                 *
                 *      AM hour values (0x01-0x0C) need no adjustment; they naturally convert to 01-12 in BCD.
                 */
                if (f12HourValue && b > 0x80) {
                    b -= (0x81 - 81);
                }
                b = (b % 10) | ((b / 10) << 4);
            }
        } else {
            if (iRTC == ChipSet.CMOS.ADDR.STATUSA) {
                /*
                 * HACK: Perform a mindless toggling of the "Update-In-Progress" bit, so that it's flipped
                 * on the next read; this makes the MODEL_5170 BIOS ("POST2_RTCUP") happy.
                 */
                this.abCMOSData[iRTC] ^= ChipSet.CMOS.STATUSA.UIP;
            }
        }
        return b;
    }

    /**
     * setRTCByte(iRTC, b)
     *
     * @param {number} iRTC
     * @param {number} b proposed byte to write
     * @return {number} actual byte to write
     */
    setRTCByte(iRTC, b)
    {
        this.assert(iRTC >= 0 && iRTC <= ChipSet.CMOS.ADDR.STATUSD);

        if (iRTC < ChipSet.CMOS.ADDR.STATUSA) {
            var fBCD = false;
            if (!(this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.BINARY)) {
                /*
                 * We're in BCD mode, so we must convert b from BCD to BINARY (we assume it's valid
                 * BCD; ie, that both nibbles contain only 0-9, not A-F).
                 */
                b = (b >> 4) * 10 + (b & 0xf);
                fBCD = true;
            }
            if (iRTC == ChipSet.CMOS.ADDR.RTC_HOUR || iRTC == ChipSet.CMOS.ADDR.RTC_HOUR_ALRM) {
                if (fBCD) {
                    /*
                     * If the original BCD hour was 0x81-0x92, then the previous BINARY-to-BCD conversion
                     * transformed it to 0x51-0x5C, so we must add 0x30.
                     */
                    if (b > 23) {
                        this.assert(b >= 0x51 && b <= 0x5c);
                        b += 0x30;
                    }
                }
                if (!(this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.HOUR24)) {
                    if (b <= 12) {
                        b = (b == 12? 0 : b);
                    } else {
                        b -= (0x80 - 12);
                        b = (b == 24? 12 : b);
                    }
                }
            }
        }
        return b;
    }

    /**
     * calcRTCCyclePeriod()
     *
     * This should be called whenever the timings in STATUSA may have changed.
     *
     * TODO: 1024 is a hard-coded number of periods per second based on the default interrupt rate of 976.562us
     * (ie, 1000000 / 976.562).  Calculate the actual number based on the values programmed in the STATUSA register.
     *
     * @this {ChipSet}
     */
    calcRTCCyclePeriod()
    {
        this.nRTCCyclesLastUpdate = this.cpu.getCycles(this.fScaleTimers);
        this.nRTCPeriodsPerSecond = 1024;
        this.nRTCCyclesPerPeriod = Math.floor(this.cpu.getBaseCyclesPerSecond() / this.nRTCPeriodsPerSecond);
        this.setRTCCycleLimit();
    }

    /**
     * getRTCCycleLimit(nCycles)
     *
     * This is called by the CPU to determine the maximum number of cycles it can process for the current burst.
     *
     * @this {ChipSet}
     * @param {number} nCycles desired
     * @return {number} maximum number of cycles (<= nCycles)
     */
    getRTCCycleLimit(nCycles)
    {
        if (this.abCMOSData && this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.PIE) {
            var nCyclesUpdate = this.nRTCCyclesNextUpdate - this.cpu.getCycles(this.fScaleTimers);
            if (nCyclesUpdate > 0) {
                if (nCycles > nCyclesUpdate) {
                    if (DEBUG && this.messageEnabled(Messages.RTC)) {
                        this.printMessage("getRTCCycleLimit(" + nCycles + "): reduced to " + nCyclesUpdate + " cycles", true);
                    }
                    nCycles = nCyclesUpdate;
                } else {
                    if (DEBUG && this.messageEnabled(Messages.RTC)) {
                        this.printMessage("getRTCCycleLimit(" + nCycles + "): already less than " + nCyclesUpdate + " cycles", true);
                    }
                }
            } else {
                if (DEBUG && this.messageEnabled(Messages.RTC)) {
                    this.printMessage("RTC next update has passed by " + nCyclesUpdate + " cycles", true);
                }
            }
        }
        return nCycles;
    }

    /**
     * setRTCCycleLimit()
     *
     * This should be called when PIE becomes set in STATUSB (and whenever PF is cleared in STATUSC while PIE is still set).
     *
     * @this {ChipSet}
     */
    setRTCCycleLimit()
    {
        var nCycles = this.nRTCCyclesPerPeriod;
        this.nRTCCyclesNextUpdate = this.cpu.getCycles(this.fScaleTimers) + nCycles;
        if (this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.PIE) {
            this.cpu.setBurstCycles(nCycles);
        }
    }

    /**
     * updateRTCTime()
     *
     * @this {ChipSet}
     */
    updateRTCTime()
    {
        var nCyclesPerSecond = this.cpu.getBaseCyclesPerSecond();
        var nCyclesUpdate = this.cpu.getCycles(this.fScaleTimers);

        /*
         * We must arrange for the very first calcRTCCyclePeriod() call to occur here, on the very first
         * updateRTCTime() call, because this is the first point we can be guaranteed that CPU cycle counts
         * are initialized (the CPU is the last component to be powered up/restored).
         *
         * TODO: A side-effect of this is that it undermines the save/restore code's preservation of last
         * and next RTC cycle counts, which may affect when the next RTC event is delivered.
         */
        if (this.nRTCCyclesPerPeriod == null) this.calcRTCCyclePeriod();

        /*
         * Step 1: Deal with Periodic Interrupts
         */
        if (nCyclesUpdate >= this.nRTCCyclesNextUpdate) {
            var bPrev = this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC];
            this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] |= ChipSet.CMOS.STATUSC.PF;
            if (this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.PIE) {
                /*
                 * When PIE is set, setBurstCycles() should be getting called as needed to ensure
                 * that updateRTCTime() is called more frequently, so let's assert that we don't have
                 * an excess of cycles and thus possibly some missed Periodic Interrupts.
                 */
                if (DEBUG) {
                    if (nCyclesUpdate - this.nRTCCyclesNextUpdate > this.nRTCCyclesPerPeriod) {
                        if (bPrev & ChipSet.CMOS.STATUSC.PF) {
                            this.printMessage("RTC interrupt handler failed to clear STATUSC", Messages.RTC);
                        } else {
                            this.printMessage("CPU took too long trigger new RTC periodic interrupt", Messages.RTC);
                        }
                    }
                }
                this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] |= ChipSet.CMOS.STATUSC.IRQF;
                this.setIRR(ChipSet.IRQ.RTC);
                /*
                 * We could also call setRTCCycleLimit() at this point, but I don't think there's any
                 * benefit until the interrupt had been acknowledged and STATUSC has been read, thereby
                 * clearing the way for another Periodic Interrupt; it seems to me that when STATUSC
                 * is read, that's the more appropriate time to call setRTCCycleLimit().
                 */
            }
            this.nRTCCyclesNextUpdate = nCyclesUpdate + this.nRTCCyclesPerPeriod;
        }

        /*
         * Step 2: Deal with Alarm Interrupts
         */
        if (this.abCMOSData[ChipSet.CMOS.ADDR.RTC_SEC] == this.abCMOSData[ChipSet.CMOS.ADDR.RTC_SEC_ALRM]) {
            if (this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MIN] == this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MIN_ALRM]) {
                if (this.abCMOSData[ChipSet.CMOS.ADDR.RTC_HOUR] == this.abCMOSData[ChipSet.CMOS.ADDR.RTC_HOUR_ALRM]) {
                    this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] |= ChipSet.CMOS.STATUSC.AF;
                    if (this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.AIE) {
                        this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] |= ChipSet.CMOS.STATUSC.IRQF;
                        this.setIRR(ChipSet.IRQ.RTC);
                    }
                }
            }
        }

        /*
         * Step 3: Update the RTC date/time and deal with Update Interrupts
         */
        var nCyclesDelta = nCyclesUpdate - this.nRTCCyclesLastUpdate;
        // DEBUG: this.assert(nCyclesDelta >= 0);
        var nSecondsDelta = Math.floor(nCyclesDelta / nCyclesPerSecond);

        /*
         * We trust that updateRTCTime() is being called as part of updateAllTimers(), and is therefore
         * being called often enough to ensure that nSecondsDelta will never be greater than one.  In fact,
         * it would always be LESS than one if it weren't also for the fact that we plow any "unused" cycles
         * (nCyclesDelta % nCyclesPerSecond) back into nRTCCyclesLastUpdate, so that we will eventually
         * see a one-second delta.
         */
        // DEBUG: this.assert(nSecondsDelta <= 1);

        /*
         * Make sure that CMOS.STATUSB.SET isn't set; if it is, then the once-per-second RTC updates must be
         * disabled so that software can write new RTC date/time values without interference.
         */
        if (nSecondsDelta && !(this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.SET)) {
            while (nSecondsDelta--) {
                if (++this.abCMOSData[ChipSet.CMOS.ADDR.RTC_SEC] >= 60) {
                    this.abCMOSData[ChipSet.CMOS.ADDR.RTC_SEC] = 0;
                    if (++this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MIN] >= 60) {
                        this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MIN] = 0;
                        if (++this.abCMOSData[ChipSet.CMOS.ADDR.RTC_HOUR] >= 24) {
                            this.abCMOSData[ChipSet.CMOS.ADDR.RTC_HOUR] = 0;
                            this.abCMOSData[ChipSet.CMOS.ADDR.RTC_WEEK_DAY] = (this.abCMOSData[ChipSet.CMOS.ADDR.RTC_WEEK_DAY] % 7) + 1;
                            var nDayMax = Usr.getMonthDays(this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH], this.abCMOSData[ChipSet.CMOS.ADDR.RTC_YEAR]);
                            if (++this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH_DAY] > nDayMax) {
                                this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH_DAY] = 1;
                                if (++this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH] > 12) {
                                    this.abCMOSData[ChipSet.CMOS.ADDR.RTC_MONTH] = 1;
                                    this.abCMOSData[ChipSet.CMOS.ADDR.RTC_YEAR] = (this.abCMOSData[ChipSet.CMOS.ADDR.RTC_YEAR] + 1) % 100;
                                }
                            }
                        }
                    }
                }
            }
            this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] |= ChipSet.CMOS.STATUSC.UF;
            if (this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.UIE) {
                this.abCMOSData[ChipSet.CMOS.ADDR.STATUSC] |= ChipSet.CMOS.STATUSC.IRQF;
                this.setIRR(ChipSet.IRQ.RTC);
            }
        }

        this.nRTCCyclesLastUpdate = nCyclesUpdate - (nCyclesDelta % nCyclesPerSecond);
    }

    /**
     * initCMOSData()
     *
     * Initialize all the CMOS configuration bytes in the range 0x0E-0x2F (TODO: Decide what to do about 0x30-0x3F)
     *
     * Note that the MODEL_5170 "SETUP" utility is normally what sets all these bytes, including the checksum, and then
     * the BIOS verifies it, but since we want our machines to pass BIOS verification "out of the box", we go the extra
     * mile here, even though it's not really our responsibility.
     *
     * @this {ChipSet}
     */
    initCMOSData()
    {
        /*
         * On all reset() calls, the RAM component(s) will (re)add their totals, so we have to make sure that
         * the addition always starts with 0.  That also means that ChipSet must always be initialized before RAM.
         */
        var iCMOS;
        for (iCMOS = ChipSet.CMOS.ADDR.BASEMEM_LO; iCMOS <= ChipSet.CMOS.ADDR.EXTMEM_HI; iCMOS++) {
            this.abCMOSData[iCMOS] = 0;
        }

        /*
         * Make sure all the "checksummed" CMOS bytes are initialized (not just the handful we set below) to ensure
         * that the checksum will be valid.
         */
        for (iCMOS = ChipSet.CMOS.ADDR.DIAG; iCMOS < ChipSet.CMOS.ADDR.CHKSUM_HI; iCMOS++) {
            if (this.abCMOSData[iCMOS] === undefined) this.abCMOSData[iCMOS] = 0;
        }

        /*
         * We propagate all compatible "legacy" SW1 bits to the CMOS.EQUIP byte using the old SW masks, but any further
         * access to CMOS.ADDR.EQUIP should use the new CMOS_EQUIP flags (eg, CMOS.EQUIP.FPU, CMOS.EQUIP.MONITOR.CGA80, etc).
         */
        this.abCMOSData[ChipSet.CMOS.ADDR.EQUIP] = this.getDIPLegacyBits(0);
        this.abCMOSData[ChipSet.CMOS.ADDR.FDRIVE] = (this.getDIPFloppyDriveType(0) << 4) | this.getDIPFloppyDriveType(1);

        /*
         * The final step is calculating the CMOS checksum, which we then store into the CMOS as a courtesy, so that the
         * user doesn't get unnecessary CMOS errors.
         */
        this.updateCMOSChecksum();
    }

    /**
     * setCMOSByte(iCMOS, b)
     *
     * This is ONLY for use by components that need to update CMOS configuration bytes to match their internal configuration.
     *
     * @this {ChipSet}
     * @param {number} iCMOS
     * @param {number} b
     * @return {boolean} true if successful, false if not (eg, CMOS not initialized yet, or no CMOS on this machine)
     */
    setCMOSByte(iCMOS, b)
    {
        if (this.abCMOSData) {
            this.assert(iCMOS >= ChipSet.CMOS.ADDR.FDRIVE && iCMOS < ChipSet.CMOS.ADDR.CHKSUM_HI);
            this.abCMOSData[iCMOS] = b;
            this.updateCMOSChecksum();
            return true;
        }
        return false;
    }

    /**
     * addCMOSMemory(addr, size)
     *
     * For use by the RAM component, to dynamically update the CMOS memory configuration.
     *
     * @this {ChipSet}
     * @param {number} addr (if 0, BASEMEM_LO/BASEMEM_HI is updated; if >= 0x100000, then EXTMEM_LO/EXTMEM_HI is updated)
     * @param {number} size (in bytes; we convert to Kb)
     * @return {boolean} true if successful, false if not (eg, CMOS not initialized yet, or no CMOS on this machine)
     */
    addCMOSMemory(addr, size)
    {
        if (this.abCMOSData) {
            var iCMOS = (addr < 0x100000? ChipSet.CMOS.ADDR.BASEMEM_LO : ChipSet.CMOS.ADDR.EXTMEM_LO);
            var wKb = this.abCMOSData[iCMOS] | (this.abCMOSData[iCMOS+1] << 8);
            wKb += (size >> 10);
            this.abCMOSData[iCMOS] = wKb & 0xff;
            this.abCMOSData[iCMOS+1] = wKb >> 8;
            this.updateCMOSChecksum();
            return true;
        }
        return false;
    }

    /**
     * setCMOSDriveType(iDrive, bType)
     *
     * For use by the HDC component, to update the CMOS drive configuration to match HDC's internal configuration.
     *
     * TODO: Consider extending this to support FDC drive updates, so that the FDC can specify diskette drive types
     * (ie, FD360 or FD1200) in the same way that HDC does.  However, historically, the ChipSet has been responsible for
     * floppy drive configuration, at least in terms of *number* of drives, through the use of SW1 settings, and we've
     * continued that tradition with the addition of the ChipSet 'floppies' parameter, which allows both the number *and*
     * capacity of drives to be specified with a simple array (eg, [360, 360] for two 360Kb drives).
     *
     * @this {ChipSet}
     * @param {number} iDrive (0 or 1)
     * @param {number} bType (0 for none, 1-14 for original drive type, 16-255 for extended drive type; 15 reserved)
     * @return {boolean} true if successful, false if not (eg, CMOS not initialized yet, or no CMOS on this machine)
     */
    setCMOSDriveType(iDrive, bType)
    {
        if (this.abCMOSData) {
            var bExt = null, iExt;
            var bOrig = this.abCMOSData[ChipSet.CMOS.ADDR.HDRIVE];
            if (bType > 15) {
                bExt = bType;  bType = 15;
            }
            if (iDrive) {
                bOrig = (bOrig & ChipSet.CMOS.HDRIVE.D0_MASK) | bType;
                iExt = ChipSet.CMOS.ADDR.EXTHDRIVE1;
            } else {
                bOrig = (bOrig & ChipSet.CMOS.HDRIVE.D1_MASK) | (bType << 4);
                iExt = ChipSet.CMOS.ADDR.EXTHDRIVE0;
            }
            this.setCMOSByte(ChipSet.CMOS.ADDR.HDRIVE, bOrig);
            if (bExt != null) this.setCMOSByte(iExt, bExt);
            return true;
        }
        return false;
    }

    /**
     * updateCMOSChecksum()
     *
     * This sums all the CMOS bytes from 0x10-0x2D, creating a 16-bit checksum.  That's a total of 30 (unsigned) 8-bit
     * values which could sum to at most 30*255 or 7650 (0x1DE2).  Since there's no way that can overflow 16 bits, we don't
     * worry about masking it with 0xffff.
     *
     * WARNING: The IBM PC AT TechRef, p.1-53 (p.75) claims that the checksum is on bytes 0x10-0x20, but that's simply wrong.
     *
     * @this {ChipSet}
     */
    updateCMOSChecksum()
    {
        var wChecksum = 0;
        for (var iCMOS = ChipSet.CMOS.ADDR.FDRIVE; iCMOS < ChipSet.CMOS.ADDR.CHKSUM_HI; iCMOS++) {
            wChecksum += this.abCMOSData[iCMOS];
        }
        this.abCMOSData[ChipSet.CMOS.ADDR.CHKSUM_LO] = wChecksum & 0xff;
        this.abCMOSData[ChipSet.CMOS.ADDR.CHKSUM_HI] = wChecksum >> 8;
    }

    /**
     * save()
     *
     * This implements save support for the ChipSet component.
     *
     * @this {ChipSet}
     * @return {Object}
     */
    save()
    {
        var state = new State(this);
        state.set(0, [this.aDIPSwitches]);
        state.set(1, [this.saveDMAControllers()]);
        state.set(2, [this.savePICs()]);
        state.set(3, [this.bPIT0Ctrl, this.saveTimers(), this.bPIT1Ctrl]);
        state.set(4, [this.bPPIA, this.bPPIB, this.bPPIC, this.bPPICtrl, this.bNMI]);
        if (this.model >= ChipSet.MODEL_5170) {
            state.set(5, [this.b8042Status, this.b8042InBuff, this.b8042CmdData,
                          this.b8042OutBuff, this.b8042InPort, this.b8042OutPort]);
            state.set(6, [this.abDMAPageSpare[7], this.abDMAPageSpare, this.bCMOSAddr, this.abCMOSData, this.nRTCCyclesLastUpdate, this.nRTCCyclesNextUpdate]);
        }
        return state.data();
    }

    /**
     * restore(data)
     *
     * This implements restore support for the ChipSet component.
     *
     * @this {ChipSet}
     * @param {Object} data
     * @return {boolean} true if successful, false if failure
     */
    restore(data)
    {
        var a, i;
        a = data[0];

        if (Array.isArray(a[0])) {
            this.aDIPSwitches = a[0];
        } else {
            this.aDIPSwitches[0][0] = a[0];
            this.aDIPSwitches[1][0] = a[1] & 0x0F;  // we do honor SW2[5] now, but it was erroneously set on some machines
            this.aDIPSwitches[0][1] = a[2];
            this.aDIPSwitches[1][1] = a[3] & 0x0F;  // we do honor SW2[5] now, but it was erroneously set on some machines
        }
        this.updateDIPSwitches();

        a = data[1];
        for (i = 0; i < this.cDMACs; i++) {
            this.initDMAController(i, a.length == 1? a[0][i] : a);
        }

        a = data[2];
        for (i = 0; i < this.cPICs; i++) {
            this.initPIC(i, i === 0? ChipSet.PIC0.PORT_LO : ChipSet.PIC1.PORT_LO, a[0][i]);
        }

        a = data[3];
        this.bPIT0Ctrl = a[0];
        this.bPIT1Ctrl = a[2];
        for (i = 0; i < this.aTimers.length; i++) {
            this.initTimer(i, a[1][i]);
        }

        a = data[4];
        this.bPPIA = a[0];
        this.bPPIB = a[1];
        this.bPPIC = a[2];
        this.bPPICtrl = a[3];
        this.bNMI  = a[4];

        a = data[5];
        if (a) {
            this.assert(this.model >= ChipSet.MODEL_5170);
            this.b8042Status = a[0];
            this.b8042InBuff = a[1];
            this.b8042CmdData = a[2];
            this.b8042OutBuff = a[3];
            this.b8042InPort = a[4];
            this.b8042OutPort = a[5];
        }

        a = data[6];
        if (a) {
            this.assert(this.model >= ChipSet.MODEL_5170);
            this.abDMAPageSpare = a[1];
            this.abDMAPageSpare[7] = a[0];  // formerly bMFGData
            this.bCMOSAddr = a[2];
            this.abCMOSData = a[3];
            this.nRTCCyclesLastUpdate = a[4];
            this.nRTCCyclesNextUpdate = a[5];
            /*
             * TODO: Decide whether restore() should faithfully preserve the RTC date/time that save() saved,
             * or always reinitialize the date/time, or give the user (or the machine configuration) the option.
             *
             * For now, we're always reinitializing the RTC date.  Alternatively, we could selectively update
             * the CMOS bytes above, instead of overwriting them all, in which case this extra call to initRTCTime()
             * could be avoided.
             */
            this.initRTCTime();
        }
        return true;
    }

    /**
     * start()
     *
     * Notification from the Computer that it's starting.
     *
     * @this {ChipSet}
     */
    start()
    {
        /*
         * Currently, all we do with this notification is allow the speaker to make noise.
         */
        this.setSpeaker();
    }

    /**
     * stop()
     *
     * Notification from the Computer that it's stopping.
     *
     * @this {ChipSet}
     */
    stop()
    {
        /*
         * Currently, all we do with this notification is prevent the speaker from making noise.
         */
        this.setSpeaker();
    }

    /**
     * initDMAController(iDMAC, aState)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {Array} [aState]
     */
    initDMAController(iDMAC, aState)
    {
        var controller = this.aDMACs[iDMAC];
        if (!controller) {
            this.assert(!aState);
            controller = {
                aChannels: new Array(4)
            };
        }
        var a = aState && aState.length >= 5? aState : ChipSet.aDMAControllerInit;
        controller.bStatus = a[0];
        controller.bCmd = a[1];
        controller.bReq = a[2];
        controller.bIndex = a[3];
        controller.nChannelBase = iDMAC << 2;
        for (var iChannel = 0; iChannel < controller.aChannels.length; iChannel++) {
            this.initDMAChannel(controller, iChannel, a[4][iChannel]);
        }
        controller.bTemp = a[5] || 0;       // not present in older states
        this.aDMACs[iDMAC] = controller;
    }

    /**
     * initDMAChannel(controller, iChannel, aState)
     *
     * @this {ChipSet}
     * @param {Object} controller
     * @param {number} iChannel
     * @param {Array} [aState]
     */
    initDMAChannel(controller, iChannel, aState)
    {
        var channel = controller.aChannels[iChannel];
        if (!channel) {
            this.assert(!aState);
            channel = {
                addrInit: [0,0],
                countInit: [0,0],
                addrCurrent: [0,0],
                countCurrent: [0,0]
            };
        }
        var a = aState && aState.length == 8? aState : ChipSet.aDMAChannelInit;
        channel.masked = a[0];
        channel.addrInit[0] = a[1][0]; channel.addrInit[1] = a[1][1];
        channel.countInit[0] = a[2][0];  channel.countInit[1] = a[2][1];
        channel.addrCurrent[0] = a[3][0]; channel.addrCurrent[1] = a[3][1];
        channel.countCurrent[0] = a[4][0]; channel.countCurrent[1] = a[4][1];
        channel.mode = a[5];
        channel.bPage = a[6];
        // a[7] is deprecated
        channel.controller = controller;
        channel.iChannel = iChannel;
        this.initDMAFunction(channel, a[8], a[9]);
        controller.aChannels[iChannel] = channel;
    }

    /**
     * initDMAFunction(channel)
     *
     * @param {Object} channel
     * @param {Component|string} [component]
     * @param {string} [sFunction]
     * @param {Object} [obj]
     * @return {*}
     */
    initDMAFunction(channel, component, sFunction, obj)
    {
        if (typeof component == "string") {
            component = Component.getComponentByID(component);
        }
        if (component) {
            channel.done = null;
            channel.sDevice = component.id;
            channel.sFunction = sFunction;
            channel.component = component;
            channel.fnTransfer = component[sFunction];
            channel.obj = obj;
        }
        return channel.fnTransfer;
    }

    /**
     * saveDMAControllers()
     *
     * @this {ChipSet}
     * @return {Array}
     */
    saveDMAControllers()
    {
        var data = [];
        for (var iDMAC = 0; iDMAC < this.aDMACs; iDMAC++) {
            var controller = this.aDMACs[iDMAC];
            data[iDMAC] = [
                controller.bStatus,
                controller.bCmd,
                controller.bReq,
                controller.bIndex,
                this.saveDMAChannels(controller),
                controller.bTemp
            ];
        }
        return data;
    }

    /**
     * saveDMAChannels(controller)
     *
     * @this {ChipSet}
     * @param {Object} controller
     * @return {Array}
     */
    saveDMAChannels(controller)
    {
        var data = [];
        for (var iChannel = 0; iChannel < controller.aChannels.length; iChannel++) {
            var channel = controller.aChannels[iChannel];
            data[iChannel] = [
                channel.masked,
                channel.addrInit,
                channel.countInit,
                channel.addrCurrent,
                channel.countCurrent,
                channel.mode,
                channel.bPage,
                channel.sDevice,
                channel.sFunction
            ];
        }
        return data;
    }

    /**
     * initPIC(iPIC, port, aState)
     *
     * @this {ChipSet}
     * @param {number} iPIC
     * @param {number} port
     * @param {Array} [aState]
     */
    initPIC(iPIC, port, aState)
    {
        var pic = this.aPICs[iPIC];
        if (!pic) {
            pic = {
                aICW:   [null,null,null,null]
            };
        }
        var a = aState && aState.length == 8? aState : ChipSet.aPICInit;
        pic.port = port;
        pic.nIRQBase = iPIC << 3;
        pic.nDelay = a[0];
        pic.aICW[0] = a[1][0]; pic.aICW[1] = a[1][1]; pic.aICW[2] = a[1][2]; pic.aICW[3] = a[1][3];
        pic.nICW = a[2];
        pic.bIMR = a[3];
        pic.bIRR = a[4];
        pic.bISR = a[5];
        pic.bIRLow = a[6];
        pic.bOCW3 = a[7];
        this.aPICs[iPIC] = pic;
    }

    /**
     * savePICs()
     *
     * @this {ChipSet}
     * @return {Array}
     */
    savePICs()
    {
        var data = [];
        for (var iPIC = 0; iPIC < this.aPICs.length; iPIC++) {
            var pic = this.aPICs[iPIC];
            data[iPIC] = [
                pic.nDelay,
                pic.aICW,
                pic.nICW,
                pic.bIMR,
                pic.bIRR,
                pic.bISR,
                pic.bIRLow,
                pic.bOCW3
            ];
        }
        return data;
    }

    /**
     * initTimer(iTimer, aState)
     *
     * @this {ChipSet}
     * @param {number} iTimer
     * @param {Array} [aState]
     */
    initTimer(iTimer, aState)
    {
        var timer = this.aTimers[iTimer];
        if (!timer) {
            timer = {
                countInit: [0,0],
                countStart: [0,0],
                countCurrent: [0,0],
                countLatched: [0,0]
            };
        }
        var a = aState && aState.length >= 13? aState : ChipSet.aTimerInit;
        timer.countInit[0] = a[0][0]; timer.countInit[1] = a[0][1];
        timer.countStart[0] = a[1][0]; timer.countStart[1] = a[1][1];
        timer.countCurrent[0] = a[2][0]; timer.countCurrent[1] = a[2][1];
        timer.countLatched[0] = a[3][0]; timer.countLatched[1] = a[3][1];
        timer.bcd = a[4];
        timer.mode = a[5];
        timer.rw = a[6];
        timer.countIndex = a[7];
        timer.countBytes = a[8];
        timer.fOUT = a[9];
        timer.fCountLatched = a[10];
        timer.fCounting = a[11];
        timer.nCyclesStart = a[12];
        timer.bStatus = a[13] || 0;
        timer.fStatusLatched = a[14] || false;
        this.aTimers[iTimer] = timer;
    }

    /**
     * saveTimers()
     *
     * @this {ChipSet}
     * @return {Array}
     */
    saveTimers()
    {
        var data = [];
        for (var iTimer = 0; iTimer < this.aTimers.length; iTimer++) {
            var timer = this.aTimers[iTimer];
            data[iTimer] = [
                timer.countInit,
                timer.countStart,
                timer.countCurrent,
                timer.countLatched,
                timer.bcd,
                timer.mode,
                timer.rw,
                timer.countIndex,
                timer.countBytes,
                timer.fOUT,
                timer.fCountLatched,
                timer.fCounting,
                timer.nCyclesStart,
                timer.bStatus,
                timer.fStatusLatched
            ];
        }
        return data;
    }

    /**
     * addDIPSwitches(iDIP, sBinding)
     *
     * @this {ChipSet}
     * @param {number} iDIP (0 or 1)
     * @param {string} sBinding is the name of the control
     */
    addDIPSwitches(iDIP, sBinding)
    {
        var sHTML = "";
        var control = this.bindings[sBinding];
        for (var i = 1; i <= 8; i++) {
            var sCellClasses = this.sCellClass;
            if (!i) sCellClasses += " " + this.sCellClass + "Left";
            var sCellID = sBinding + "-" + i;
            sHTML += "<div id=\"" + sCellID + "\" class=\"" + sCellClasses + "\" data-value=\"0\">" + i + "</div>\n";
        }
        control.innerHTML = sHTML;
        this.updateDIPSwitchControls(iDIP, sBinding, true);
    }

    /**
     * findDIPSwitch(iDIP, iSwitch)
     *
     * @this {ChipSet}
     * @param {number} iDIP
     * @param {number} iSwitch
     * @return {Object|null} DIPSW switchGroup containing the DIP switch's MASK, VALUES, and LABEL, or null if none
     */
    findDIPSwitch(iDIP, iSwitch)
    {
        var switchDIPs = ChipSet.DIPSW[this.model|0];
        var switchTypes = switchDIPs && switchDIPs[iDIP];
        if (switchTypes) {
            for (var iType in switchTypes) {
                var switchGroup = switchTypes[iType];
                if (switchGroup.MASK & (1 << iSwitch)) {
                    return switchGroup;
                }
            }
        }
        return null;
    }

    /**
     * getDIPLegacyBits(iDIP)
     *
     * @this {ChipSet}
     * @param {number} iDIP
     * @return {number|undefined}
     */
    getDIPLegacyBits(iDIP)
    {
        var b;
        if (!iDIP) {
            b = 0;
            b |= (this.getDIPVideoMonitor() << ChipSet.PPI_SW.MONITOR.SHIFT) & ChipSet.PPI_SW.MONITOR.MASK;
            b |= (this.getDIPCoprocessor()? ChipSet.PPI_SW.FPU : 0);
            var nDrives = this.getDIPFloppyDrives();
            b |= (nDrives? ((((nDrives - 1) << ChipSet.PPI_SW.FDRIVE.SHIFT) & ChipSet.PPI_SW.FDRIVE.MASK) | ChipSet.PPI_SW.FDRIVE.IPL) : 0);
        }
        return b;
    }

    /**
     * getDIPSwitches(iType, fInit)
     *
     * @this {ChipSet}
     * @param {number} iType
     * @param {boolean} [fInit] is true for initial switch value, current value otherwise
     * @return {*|null}
     */
    getDIPSwitches(iType, fInit)
    {
        var value = null;
        var switchDIPs = ChipSet.DIPSW[this.model] || ChipSet.DIPSW[this.model|0] || ChipSet.DIPSW[ChipSet.MODEL_5150];
        for (var iDIP = 0; iDIP < switchDIPs.length; iDIP++) {
            var switchTypes = switchDIPs[iDIP];
            if (switchTypes) {
                var switchGroup = switchTypes[iType];
                if (switchGroup) {
                    var bits = this.aDIPSwitches[iDIP][fInit?0:1] & switchGroup.MASK;
                    for (var v in switchGroup.VALUES) {
                        if (switchGroup.VALUES[v] == bits) {
                            value = v;
                            /*
                             * We prefer numeric properties, and all switch definitions must provide them
                             * if their helper functions (eg, getDIPVideoMonitor()) expect numeric properties.
                             */
                            if (typeof +value == 'number') break;
                        }
                    }
                    break;
                }
            }
        }
        return value;
    }

    /**
     * getDIPCoprocessor(fInit)
     *
     * @this {ChipSet}
     * @param {boolean} [fInit] is true for init switch value(s) only, current value(s) otherwise
     * @return {number} 1 if installed, 0 if not
     */
    getDIPCoprocessor(fInit)
    {
        var n = /** @type {number} */ (this.getDIPSwitches(ChipSet.SWITCH_TYPE.FPU, fInit));
        return +n;
    }

    /**
     * getDIPFloppyDrives(fInit)
     *
     * @this {ChipSet}
     * @param {boolean} [fInit] is true for init switch value(s) only, current value(s) otherwise
     * @return {number} number of floppy drives specified by SW1 (range is 0 to 4)
     */
    getDIPFloppyDrives(fInit)
    {
        var n = /** @type {number} */ (this.getDIPSwitches(ChipSet.SWITCH_TYPE.FLOPNUM, fInit));
        return +n;
    }

    /**
     * getDIPFloppyDriveType(iDrive)
     *
     * @this {ChipSet}
     * @param {number} iDrive (0-based)
     * @return {number} one of the ChipSet.CMOS.FDRIVE.FD* values (FD360, FD1200, etc)
     */
    getDIPFloppyDriveType(iDrive)
    {
        if (iDrive < this.getDIPFloppyDrives()) {
            if (!this.aFloppyDrives) {
                return ChipSet.CMOS.FDRIVE.FD360;
            }
            if (iDrive < this.aFloppyDrives.length) {
                switch(this.aFloppyDrives[iDrive]) {
                case 160:
                case 180:
                case 320:
                case 360:
                    return ChipSet.CMOS.FDRIVE.FD360;
                case 720:
                    return ChipSet.CMOS.FDRIVE.FD720;
                case 1200:
                    return ChipSet.CMOS.FDRIVE.FD1200;
                case 1440:
                    return ChipSet.CMOS.FDRIVE.FD1440;
                }
            }
            this.assert(false);  // we should never get here (else something is out of out sync)
        }
        return ChipSet.CMOS.FDRIVE.NONE;
    }

    /**
     * getDIPFloppyDriveSize(iDrive)
     *
     * @this {ChipSet}
     * @param {number} iDrive (0-based)
     * @return {number} capacity of drive in Kb (eg, 360, 1200, 1440, etc), or 0 if none
     */
    getDIPFloppyDriveSize(iDrive)
    {
        if (iDrive < this.getDIPFloppyDrives()) {
            if (!this.aFloppyDrives) {
                return 360;
            }
            if (iDrive < this.aFloppyDrives.length) {
                return this.aFloppyDrives[iDrive];
            }
            this.assert(false);  // we should never get here (else something is out of out sync)
        }
        return 0;
    }

    /**
     * getDIPMemorySize(fInit)
     *
     * @this {ChipSet}
     * @param {boolean} [fInit] is true for init switch value(s) only, current value(s) otherwise
     * @return {number} number of Kb of specified memory (NOT necessarily the same as installed memory; see RAM component)
     */
    getDIPMemorySize(fInit)
    {
        var nKBLowMem = /** @type {number} */ (this.getDIPSwitches(ChipSet.SWITCH_TYPE.LOWMEM, fInit));
        var nKBExpMem = /** @type {number} */ (this.getDIPSwitches(ChipSet.SWITCH_TYPE.EXPMEM, fInit));
        return +nKBLowMem + +nKBExpMem;
    }

    /**
     * getDIPVideoMonitor(fInit)
     *
     * @this {ChipSet}
     * @param {boolean} [fInit] is true for init switch value(s) only, current value(s) otherwise
     * @return {number} one of ChipSet.MONITOR.*
     */
    getDIPVideoMonitor(fInit)
    {
        var n = /** @type {number} */ (this.getDIPSwitches(ChipSet.SWITCH_TYPE.MONITOR, fInit));
        return +n;
    }

    /**
     * parseDIPSwitches(sBits, bDefault)
     *
     * @this {ChipSet}
     * @param {string} sBits describing switch settings
     * @param {number} [bDefault]
     * @return {number|undefined}
     */
    parseDIPSwitches(sBits, bDefault)
    {
        var b = bDefault;
        if (sBits) {
            /*
             * NOTE: We can't use parseInt() with a base of 2, because both bit order and bit sense are reversed.
             */
            b = 0;
            var bit = 0x1;
            for (var i = 0; i < sBits.length; i++) {
                if (sBits.charAt(i) == "0") b |= bit;
                bit <<= 1;
            }
        }
        return b;
    }

    /**
     * setDIPSwitches(iType, value, fInit)
     *
     * @this {ChipSet}
     * @param {number} iType
     * @param {*} value
     * @param {boolean} [fInit]
     * @return {boolean} true if successful, false if unrecognized type and/or value
     */
    setDIPSwitches(iType, value, fInit)
    {
        var switchDIPs = ChipSet.DIPSW[this.model] || ChipSet.DIPSW[this.model|0] || ChipSet.DIPSW[ChipSet.MODEL_5150];
        for (var iDIP = 0; iDIP < switchDIPs.length; iDIP++) {
            var switchTypes = switchDIPs[iDIP];
            if (switchTypes) {
                var switchGroup = switchTypes[iType];
                if (switchGroup) {
                    for (var v in switchGroup.VALUES) {
                        if (v == value) {
                            this.aDIPSwitches[iDIP][fInit?0:1] &= ~switchGroup.MASK;
                            this.aDIPSwitches[iDIP][fInit?0:1] |= switchGroup.VALUES[v];
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    /**
     * getDIPSwitchControl(control)
     *
     * @this {ChipSet}
     * @param {HTMLElement} control is an HTML control DOM object
     * @return {boolean} true if the switch represented by e is "on", false if "off"
     */
    getDIPSwitchControl(control)
    {
        return control.getAttribute("data-value") == "1";
    }

    /**
     * setDIPSwitchControl(control, f)
     *
     * @this {ChipSet}
     * @param {HTMLElement} control is an HTML control DOM object
     * @param {boolean} f is true if the switch represented by control should be "on", false if "off"
     */
    setDIPSwitchControl(control, f)
    {
        control.setAttribute("data-value", f? "1" : "0");
        control.style.color = (f? "#ffffff" : "#000000");
        control.style.backgroundColor = (f? "#000000" : "#ffffff");
    }

    /**
     * toggleDIPSwitchControl(control)
     *
     * @this {ChipSet}
     * @param {HTMLElement} control is an HTML control DOM object
     */
    toggleDIPSwitchControl(control)
    {
        var f = !this.getDIPSwitchControl(control);
        this.setDIPSwitchControl(control, f);
        var sID = control.getAttribute("id");
        var asParts = sID.split("-");
        var b = (0x1 << (+asParts[1] - 1));
        switch (asParts[0]) {
        case ChipSet.CONTROLS.SW1:
            this.aDIPSwitches[0][0] = (this.aDIPSwitches[0][0] & ~b) | (f? 0 : b);
            break;
        case ChipSet.CONTROLS.SW2:
            this.aDIPSwitches[1][0] = (this.aDIPSwitches[1][0] & ~b) | (f? 0 : b);
            break;
        default:
            break;
        }
        this.updateDIPSwitchDescriptions();
    }

    /**
     * updateDIPSwitches()
     *
     * @this {ChipSet}
     */
    updateDIPSwitches()
    {
        this.updateDIPSwitchControls(0, ChipSet.CONTROLS.SW1);
        this.updateDIPSwitchControls(1, ChipSet.CONTROLS.SW2);
        this.updateDIPSwitchDescriptions();
    }

    /**
     * updateDIPSwitchControls(iDIP, sBinding, fInit)
     *
     * @this {ChipSet}
     * @param {number} iDIP (0 or 1)
     * @param {string} sBinding is the name of the control
     * @param {boolean} [fInit]
     */
    updateDIPSwitchControls(iDIP, sBinding, fInit)
    {
        var control = this.bindings[sBinding];
        if (control) {
            var v;
            if (fInit) {
                v = this.aDIPSwitches[iDIP][0];
            } else {
                v = this.aDIPSwitches[iDIP][1] = this.aDIPSwitches[iDIP][0];
            }
            var aeCells = Component.getElementsByClass(control, this.sCellClass);
            for (var i = 0; i < aeCells.length; i++) {
                var switchGroup = this.findDIPSwitch(iDIP, i);
                var sLabel = switchGroup && switchGroup.LABEL || "Reserved";
                aeCells[i].setAttribute("title", sLabel);
                this.setDIPSwitchControl(aeCells[i], !(v & (0x1 << i)));
                aeCells[i].onclick = function(chipset, eSwitch) {
                    /*
                     *  If we defined the onclick handler below as "function(e)" instead of simply "function()", then we could
                     *  also receive an event object (e); however, IE reportedly requires that we examine a global (window.event)
                     *  instead.  If that's true, and if we ever care to get more details about the click event, then we might
                     *  have to worry about that (eg, define a local var: "var event = window.event || e").
                     */
                    return function onClickSwitch() {
                        chipset.toggleDIPSwitchControl(eSwitch);
                    };
                }(this, aeCells[i]);
            }
        }
    }

    /**
     * updateDIPSwitchDescriptions()
     *
     * @this {ChipSet}
     */
    updateDIPSwitchDescriptions()
    {
        var controlDesc = this.bindings[ChipSet.CONTROLS.SWDESC];
        if (controlDesc != null) {
            var sText = "";
            /*
             * TODO: Monitor type 0 used to be "None" (ie, "No Monitor"), which was correct in a pre-EGA world,
             * but in the post-EGA world, it depends.  We should ask the Video component for a definitive answer.
             */
            var asMonitorTypes = {
                0: "Enhanced Color",
                1: "TV",
                2: "Color",
                3: "Monochrome"
            };
            sText += this.getDIPMemorySize(true) + "Kb";
            sText += ", " + (+this.getDIPCoprocessor(true)? "" : "No ") + "FPU";
            sText += ", " + asMonitorTypes[this.getDIPVideoMonitor(true)] + " Monitor";
            sText += ", " + this.getDIPFloppyDrives(true) + " Floppy Drives";
            if (this.aDIPSwitches[0][1] != null && this.aDIPSwitches[0][1] != this.aDIPSwitches[0][0] ||
                this.aDIPSwitches[1][1] != null && this.aDIPSwitches[1][1] != this.aDIPSwitches[1][0]) {
                sText += " (Reset required)";
            }
            controlDesc.textContent = sText;
        }
    }

    /**
     * dumpPIC()
     *
     * @this {ChipSet}
     */
    dumpPIC()
    {
        if (DEBUGGER) {
            for (var iPIC = 0; iPIC < this.aPICs.length; iPIC++) {
                var pic = this.aPICs[iPIC];
                var sDump = "PIC" + iPIC + ":";
                for (var i = 0; i < pic.aICW.length; i++) {
                    var b = pic.aICW[i];
                    sDump += " IC" + (i + 1) + '=' + Str.toHexByte(b);
                }
                sDump += " IMR=" + Str.toHexByte(pic.bIMR) + " IRR=" + Str.toHexByte(pic.bIRR) + " ISR=" + Str.toHexByte(pic.bISR) + " DELAY=" + pic.nDelay;
                this.dbg.println(sDump);
            }
        }
    }

    /**
     * dumpTimer(asArgs)
     *
     * Use "d timer" to dump all timers, or "d timer n" to dump only timer n.
     *
     * @this {ChipSet}
     * @param {Array.<string>} asArgs
     */
    dumpTimer(asArgs)
    {
        if (DEBUGGER) {
            var sParm = asArgs[0];
            var nTimer = (sParm? +sParm : null);
            for (var iTimer = 0; iTimer < this.aTimers.length; iTimer++) {
                if (nTimer != null && iTimer != nTimer) continue;
                this.updateTimer(iTimer);
                var timer = this.aTimers[iTimer];
                var sDump = "TIMER" + iTimer + ":";
                var count = 0;
                if (timer.countBytes != null) {
                    for (var i = 0; i <= timer.countBytes; i++) {
                        count |= (timer.countCurrent[i] << (i * 8));
                    }
                }
                sDump += " mode=" + (timer.mode >> 1) + " bytes=" + timer.countBytes + " count=" + Str.toHexWord(count);
                this.dbg.println(sDump);
            }
        }
    }

    /**
     * dumpCMOS()
     *
     * @this {ChipSet}
     */
    dumpCMOS()
    {
        if (DEBUGGER) {
            var sDump = "";
            for (var iCMOS = 0; iCMOS < ChipSet.CMOS.ADDR.TOTAL; iCMOS++) {
                var b = (iCMOS <= ChipSet.CMOS.ADDR.STATUSD? this.getRTCByte(iCMOS) : this.abCMOSData[iCMOS]);
                if (sDump) sDump += '\n';
                sDump += "CMOS[" + Str.toHexByte(iCMOS) + "]: " + Str.toHexByte(b);
            }
            this.dbg.println(sDump);
        }
    }

    /**
     * inDMAChannelAddr(iDMAC, iChannel, port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} iChannel
     * @param {number} port (0x00, 0x02, 0x04, 0x06 for DMAC 0, 0xC0, 0xC4, 0xC8, 0xCC for DMAC 1)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inDMAChannelAddr(iDMAC, iChannel, port, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        var channel = controller.aChannels[iChannel];
        var b = channel.addrCurrent[controller.bIndex];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "DMA" + iDMAC + ".CHANNEL" + iChannel + ".ADDR[" + controller.bIndex + "]", b, true);
        }
        controller.bIndex ^= 0x1;
        /*
         * Technically, aTimers[1].fOut is what drives DMA requests for DMA channel 0 (ChipSet.DMA_REFRESH),
         * every 15us, once the BIOS has initialized the channel's "mode" with MODE_SINGLE, INCREMENT, AUTOINIT,
         * and TYPE_READ (0x58) and initialized TIMER1 appropriately.
         *
         * However, we don't need to be that particular.  Simply simulate an ever-increasing address after every
         * read of the full DMA channel 0 address.
         */
        if (!iDMAC && iChannel == ChipSet.DMA_REFRESH && !controller.bIndex) {
            channel.addrCurrent[0]++;
            if (channel.addrCurrent[0] > 0xff) {
                channel.addrCurrent[0] = 0;
                channel.addrCurrent[1]++;
                if (channel.addrCurrent[1] > 0xff) {
                    channel.addrCurrent[1] = 0;
                }
            }
        }
        return b;
    }

    /**
     * outDMAChannelAddr(iDMAC, iChannel, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} iChannel
     * @param {number} port (0x00, 0x02, 0x04, 0x06 for DMAC 0, 0xC0, 0xC4, 0xC8, 0xCC for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAChannelAddr(iDMAC, iChannel, port, bOut, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".CHANNEL" + iChannel + ".ADDR[" + controller.bIndex + "]", null, true);
        }
        var channel = controller.aChannels[iChannel];
        channel.addrCurrent[controller.bIndex] = channel.addrInit[controller.bIndex] = bOut;
        controller.bIndex ^= 0x1;
    }

    /**
     * inDMAChannelCount(iDMAC, iChannel, port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} iChannel
     * @param {number} port (0x01, 0x03, 0x05, 0x07 for DMAC 0, 0xC2, 0xC6, 0xCA, 0xCE for DMAC 1)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inDMAChannelCount(iDMAC, iChannel, port, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        var channel = controller.aChannels[iChannel];
        var b = channel.countCurrent[controller.bIndex];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "DMA" + iDMAC + ".CHANNEL" + iChannel + ".COUNT[" + controller.bIndex + "]", b, true);
        }
        controller.bIndex ^= 0x1;
        /*
         * Technically, aTimers[1].fOut is what drives DMA requests for DMA channel 0 (ChipSet.DMA_REFRESH),
         * every 15us, once the BIOS has initialized the channel's "mode" with MODE_SINGLE, INCREMENT, AUTOINIT,
         * and TYPE_READ (0x58) and initialized TIMER1 appropriately.
         *
         * However, we don't need to be that particular.  Simply simulate an ever-decreasing count after every
         * read of the full DMA channel 0 count.
         */
        if (!iDMAC && iChannel == ChipSet.DMA_REFRESH && !controller.bIndex) {
            channel.countCurrent[0]--;
            if (channel.countCurrent[0] < 0) {
                channel.countCurrent[0] = 0xff;
                channel.countCurrent[1]--;
                if (channel.countCurrent[1] < 0) {
                    channel.countCurrent[1] = 0xff;
                    /*
                     * This is the logical point to indicate Terminal Count (TC), but again, there's no need to be
                     * so particular; inDMAStatus() has its own logic for periodically signalling TC.
                     */
                }
            }
        }
        return b;
    }

    /**
     * outDMAChannelCount(iDMAC, iChannel, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} iChannel (ports 0x01, 0x03, 0x05, 0x07)
     * @param {number} port (0x01, 0x03, 0x05, 0x07 for DMAC 0, 0xC2, 0xC6, 0xCA, 0xCE for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAChannelCount(iDMAC, iChannel, port, bOut, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".CHANNEL" + iChannel + ".COUNT[" + controller.bIndex + "]", null, true);
        }
        var channel = controller.aChannels[iChannel];
        channel.countCurrent[controller.bIndex] = channel.countInit[controller.bIndex] = bOut;
        controller.bIndex ^= 0x1;
    }

    /**
     * inDMAStatus(iDMAC, port, addrFrom)
     *
     * From the 8237A spec:
     *
     * "The Status register is available to be read out of the 8237A by the microprocessor.
     * It contains information about the status of the devices at this point. This information includes
     * which channels have reached Terminal Count (TC) and which channels have pending DMA requests.
     *
     * Bits 0–3 are set every time a TC is reached by that channel or an external EOP is applied.
     * These bits are cleared upon Reset and on each Status Read.
     *
     * Bits 4–7 are set whenever their corresponding channel is requesting service."
     *
     * TRIVIA: This hook wasn't installed when I was testing with the MODEL_5150 ROM BIOS, and it
     * didn't matter, but the MODEL_5160 ROM BIOS checks it several times, including @F000:E156, where
     * it verifies that TIMER1 didn't request service on channel 0.
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x08 for DMAC 0, 0xD0 for DMAC 1)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inDMAStatus(iDMAC, port, addrFrom)
    {
        /*
         * HACK: Unlike the MODEL_5150, the MODEL_5160 ROM BIOS checks DMA channel 0 for TC (@F000:E4DF)
         * after running a number of unrelated tests, since enough time would have passed for channel 0 to
         * have reached TC at least once.  So I simply OR in a hard-coded TC bit for channel 0 every time
         * status is read.
         */
        var controller = this.aDMACs[iDMAC];
        var b = controller.bStatus | ChipSet.DMA_STATUS.CH0_TC;
        controller.bStatus &= ~ChipSet.DMA_STATUS.ALL_TC;
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "DMA" + iDMAC + ".STATUS", b, true);
        }
        return b;
    }

    /**
     * outDMACmd(iDMAC, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x08 for DMAC 0, 0xD0 for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMACmd(iDMAC, port, bOut, addrFrom)
    {
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".CMD", null, true);
        }
        this.aDMACs[iDMAC].bCmd = bOut;
    }

    /**
     * outDMAReq(iDMAC, port, bOut, addrFrom)
     *
     * From the 8237A spec:
     *
     * "The 8237A can respond to requests for DMA service which are initiated by software as well as by a DREQ.
     * Each channel has a request bit associated with it in the 4-bit Request register. These are non-maskable and subject
     * to prioritization by the Priority Encoder network. Each register bit is set or reset separately under software
     * control or is cleared upon generation of a TC or external EOP. The entire register is cleared by a Reset.
     *
     * To set or reset a bit the software loads the proper form of the data word.... In order to make a software request,
     * the channel must be in Block Mode."
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x09 for DMAC 0, 0xD2 for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAReq(iDMAC, port, bOut, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".REQ", null, true);
        }
        /*
         * Bits 0-1 contain the channel number
         */
        var iChannel = (bOut & 0x3);
        /*
         * Bit 2 is the request bit (0 to reset, 1 to set), which must be propagated to the corresponding bit (4-7) in the status register
         */
        var iChannelBit = ((bOut & 0x4) << (iChannel + 2));
        controller.bStatus = (controller.bStatus & ~(0x10 << iChannel)) | iChannelBit;
        controller.bReq = bOut;
    }

    /**
     * outDMAMask(iDMAC, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x0A for DMAC 0, 0xD4 for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAMask(iDMAC, port, bOut, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".MASK", null, true);
        }
        var iChannel = bOut & ChipSet.DMA_MASK.CHANNEL;
        var channel = controller.aChannels[iChannel];
        channel.masked = !!(bOut & ChipSet.DMA_MASK.CHANNEL_SET);
        if (!channel.masked) this.requestDMA(controller.nChannelBase + iChannel);
    }

    /**
     * outDMAMode(iDMAC, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x0B for DMAC 0, 0xD6 for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAMode(iDMAC, port, bOut, addrFrom)
    {
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".MODE", null, true);
        }
        var iChannel = bOut & ChipSet.DMA_MODE.CHANNEL;
        this.aDMACs[iDMAC].aChannels[iChannel].mode = bOut;
    }

    /**
     * outDMAResetFF(iDMAC, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x0C for DMAC 0, 0xD8 for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     *
     * Any write to this port simply resets the controller's "first/last flip-flop", which determines whether
     * the even or odd byte of a DMA address or count register will be accessed next.
     */
    outDMAResetFF(iDMAC, port, bOut, addrFrom)
    {
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".RESET_FF", null, true);
        }
        this.aDMACs[iDMAC].bIndex = 0;
    }

    /**
     * inDMATemp(iDMAC, port, addrFrom)
     *
     * From the 8237A spec:
     *
     * "The Temporary register is used to hold data during memory-to-memory transfers  Following the
     * completion of the transfers, the last word moved can be read by the microprocessor in the Program Condition.
     * The Temporary register always contains the last byte transferred in the previous memory-to-memory operation,
     * unless cleared by a Reset."
     *
     * TRIVIA: This hook wasn't installed when I was testing with ANY of the IBM ROMs, but it's required
     * by the AT&T 6300 (aka Olivetti M24) ROM.
     *
     * TODO: When support is added for memory-to-memory transfers, bTemp needs to be updated according to spec.
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x0D for DMAC 0, 0xDA for DMAC 1)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inDMATemp(iDMAC, port, addrFrom)
    {
        var controller = this.aDMACs[iDMAC];
        var b = controller.bTemp;
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "DMA" + iDMAC + ".TEMP", b, true);
        }
        return b;
    }

    /**
     * outDMAMasterClear(iDMAC, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} port (0x0D for DMAC 0, 0xDA for DMAC 1)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAMasterClear(iDMAC, port, bOut, addrFrom)
    {
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".MASTER_CLEAR", null, true);
        }
        /*
         * The value written to this port doesn't matter; any write triggers a "master clear" operation
         *
         * TODO: Can't we just call initDMAController(), which would also take care of clearing controller.bStatus?
         */
        var controller = this.aDMACs[iDMAC];
        for (var i = 0; i < controller.aChannels.length; i++) {
            this.initDMAChannel(controller, i);
        }
    }

    /**
     * inDMAPageReg(iDMAC, iChannel, port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} iChannel
     * @param {number} port
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inDMAPageReg(iDMAC, iChannel, port, addrFrom)
    {
        var bIn = this.aDMACs[iDMAC].aChannels[iChannel].bPage;
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "DMA" + iDMAC + ".CHANNEL" + iChannel + ".PAGE", bIn, true);
        }
        return bIn;
    }

    /**
     * outDMAPageReg(iDMAC, iChannel, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDMAC
     * @param {number} iChannel
     * @param {number} port
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAPageReg(iDMAC, iChannel, port, bOut, addrFrom)
    {
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "DMA" + iDMAC + ".CHANNEL" + iChannel + ".PAGE", null, true);
        }
        this.aDMACs[iDMAC].aChannels[iChannel].bPage = bOut;
    }

    /**
     * inDMAPageSpare(iSpare, port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iSpare
     * @param {number} port
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inDMAPageSpare(iSpare, port, addrFrom)
    {
        var bIn = this.abDMAPageSpare[iSpare];
        if (this.messageEnabled(Messages.DMA | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "DMA.SPARE" + iSpare + ".PAGE", bIn, true);
        }
        return bIn;
    }

    /**
     * outDMAPageSpare(iSpare, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iSpare
     * @param {number} port
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outDMAPageSpare(iSpare, port, bOut, addrFrom)
    {
        /*
         * TODO: Remove this DEBUG-only DESKPRO386 code once we're done debugging DeskPro 386 ROMs;
         * it enables logging of all DeskPro 386 ROM checkpoint I/O to port 0x84.
         */
        if (this.messageEnabled(Messages.DMA | Messages.PORT) || DEBUG && (this.model|0) == ChipSet.MODEL_COMPAQ_DESKPRO386 && port == 0x84) {
            this.printMessageIO(port, bOut, addrFrom, "DMA.SPARE" + iSpare + ".PAGE", null, true);
        }
        this.abDMAPageSpare[iSpare] = bOut;
    }

    /**
     * connectDMA(iDMAChannel, component, sFunction, obj)
     *
     * @param {number} iDMAChannel
     * @param {Component|string} component
     * @param {string} sFunction
     * @param {Object} obj (eg, when the HDC connects, it passes a drive object)
     */
    connectDMA(iDMAChannel, component, sFunction, obj)
    {
        var iDMAC = iDMAChannel >> 2;
        var controller = this.aDMACs[iDMAC];

        var iChannel = iDMAChannel & 0x3;
        var channel = controller.aChannels[iChannel];

        this.initDMAFunction(channel, component, sFunction, obj);
    }

    /**
     * requestDMA(iDMAChannel, done)
     *
     * @this {ChipSet}
     * @param {number} iDMAChannel
     * @param {function(boolean)} [done]
     *
     * For DMA_MODE.TYPE_WRITE transfers, fnTransfer(-1) must return bytes as long as we request them (although it may
     * return -1 if it runs out of bytes prematurely).
     *
     * Similarly, for DMA_MODE.TYPE_READ transfers, fnTransfer(b) must accept bytes as long as we deliver them (although
     * it is certainly free to ignore bytes it no longer wants).
     */
    requestDMA(iDMAChannel, done)
    {
        var iDMAC = iDMAChannel >> 2;
        var controller = this.aDMACs[iDMAC];

        var iChannel = iDMAChannel & 0x3;
        var channel = controller.aChannels[iChannel];

        if (!channel.component || !channel.fnTransfer || !channel.obj) {
            if (DEBUG && this.messageEnabled(Messages.DMA | Messages.DATA)) {
                this.printMessage("requestDMA(" + iDMAChannel + "): not connected to a component", true);
            }
            if (done) done(true);
            return;
        }

        /*
         * We can't simply slam done into channel.done; that would be fine if requestDMA() was called only by functions
         * like HDC.doRead() and HDC.doWrite(), but we're also called whenever a DMA channel is unmasked, and in those cases,
         * we need to preserve whatever handler may have been previously set.
         *
         * However, in an effort to ensure we don't end up with stale done handlers, connectDMA() will reset channel.done.
         */
        if (done) channel.done = done;

        if (channel.masked) {
            if (DEBUG && this.messageEnabled(Messages.DMA | Messages.DATA)) {
                this.printMessage("requestDMA(" + iDMAChannel + "): channel masked, request queued", true);
            }
            return;
        }

        /*
         * Let's try to do async DMA without asking the CPU for help...
         *
         *      this.cpu.setDMA(true);
         */
        this.advanceDMA(channel, true);
    }

    /**
     * advanceDMA(channel, fInit)
     *
     * @this {ChipSet}
     * @param {Object} channel
     * @param {boolean} [fInit]
     */
    advanceDMA(channel, fInit)
    {
        if (fInit) {
            channel.count = (channel.countCurrent[1] << 8) | channel.countCurrent[0];
            channel.type = (channel.mode & ChipSet.DMA_MODE.TYPE);
            channel.fWarning = channel.fError = false;
            if (DEBUG && DEBUGGER) {
                channel.cbDebug = channel.count + 1;
                channel.sAddrDebug = (DEBUG && DEBUGGER? null : undefined);
            }
        }
        /*
         * To support async DMA without requiring help from the CPU (ie, without relying upon cpu.setDMA()), we require that
         * the data transfer functions provide an fAsync parameter to their callbacks; fAsync must be true if the callback was
         * truly asynchronous (ie, it had to wait for a remote I/O request to finish), or false if the data was already available
         * and the callback was performed synchronously.
         *
         * Whenever a callback is issued asynchronously, we will immediately daisy-chain another pair of updateDMA()/advanceDMA()
         * calls, which will either finish the DMA operation if no more remote I/O requests are required, or will queue up another
         * I/O request, which will in turn trigger another async callback.  Thus, the DMA request keeps itself going without
         * requiring any special assistance from the CPU via setDMA().
         */
        var bto = null;
        var chipset = this;
        var fAsyncRequest = false;
        var controller = channel.controller;
        var iDMAChannel = controller.nChannelBase + channel.iChannel;

        while (true) {
            if (channel.count >= 0) {
                var b;
                var addr = (channel.bPage << 16) | (channel.addrCurrent[1] << 8) | channel.addrCurrent[0];
                if (DEBUG && DEBUGGER && channel.sAddrDebug === null) {
                    channel.sAddrDebug = Str.toHex(addr >> 4, 4) + ":" + Str.toHex(addr & 0xf, 4);
                    if (this.messageEnabled(this.messageBitsDMA(iDMAChannel)) && channel.type != ChipSet.DMA_MODE.TYPE_WRITE) {
                        this.printMessage("advanceDMA(" + iDMAChannel + ") transferring " + channel.cbDebug + " bytes from " + channel.sAddrDebug, true);
                        this.dbg.doDump(["db", channel.sAddrDebug, 'l', channel.cbDebug]);
                    }
                }
                if (channel.type == ChipSet.DMA_MODE.TYPE_WRITE) {
                    fAsyncRequest = true;
                    (function advanceDMAWrite(addrCur) {
                        channel.fnTransfer.call(channel.component, channel.obj, -1, function onTransferDMA(b, fAsync, obj, off) {
                            if (b < 0) {
                                if (!channel.fWarning) {
                                    if (DEBUG && chipset.messageEnabled(Messages.DMA)) {
                                        chipset.printMessage("advanceDMA(" + iDMAChannel + ") ran out of data, assuming 0xff", true);
                                    }
                                    channel.fWarning = true;
                                }
                                /*
                                 * TODO: Determine whether to abort, as we do for DMA_MODE.TYPE_READ.
                                 */
                                b = 0xff;
                            }
                            if (!channel.masked) {
                                chipset.bus.setByte(addrCur, b);
                                /*
                                 * WARNING: Do NOT assume that obj is valid; if the sector data was not found, there will be no obj.
                                 */
                                if (BACKTRACK && obj) {
                                    if (!off && obj.file) {
                                        if (chipset.messageEnabled(Messages.DISK)) {
                                            chipset.printMessage("loading " + obj.file.sPath + '[' + obj.offFile + "] at %" + Str.toHex(addrCur), true);
                                        }
                                        /*
                                        if (obj.file.sPath == "\\SYSBAS.EXE" && obj.offFile == 512) {
                                            chipset.cpu.stopCPU();
                                        }
                                        */
                                    }
                                    bto = chipset.bus.addBackTrackObject(obj, bto, off);
                                    chipset.bus.writeBackTrackObject(addrCur, bto, off);
                                }
                            }
                            fAsyncRequest = fAsync;
                            if (fAsync) {
                                setTimeout(function() {
                                    if (!chipset.updateDMA(channel)) chipset.advanceDMA(channel);
                                }, 0);
                            }
                        });
                    }(addr));
                }
                else if (channel.type == ChipSet.DMA_MODE.TYPE_READ) {
                    /*
                     * TODO: Determine whether we should support async dmaWrite() functions (currently not required)
                     */
                    b = chipset.bus.getByte(addr);
                    if (channel.fnTransfer.call(channel.component, channel.obj, b) < 0) {
                        /*
                         * In this case, I think I have no choice but to terminate the DMA operation in response to a failure,
                         * because the ROM BIOS FDC.REG_DATA.CMD.FORMAT_TRACK command specifies a count that is MUCH too large
                         * (a side-effect of the ROM BIOS using the same "DMA_SETUP" code for reads, writes AND formats).
                         */
                        channel.fError = true;
                    }
                }
                else if (channel.type == ChipSet.DMA_MODE.TYPE_VERIFY) {
                    /*
                     * Nothing to read or write; just call updateDMA()
                     */
                }
                else {
                    if (DEBUG && this.messageEnabled(Messages.DMA | Messages.WARN)) {
                        this.printMessage("advanceDMA(" + iDMAChannel + ") unsupported transfer type: " + Str.toHexWord(channel.type), true);
                    }
                    channel.fError = true;
                }
            }
            if (fAsyncRequest || this.updateDMA(channel)) break;
        }
    }

    /**
     * updateDMA(channel)
     *
     * @this {ChipSet}
     * @param {Object} channel
     * @return {boolean} true if DMA operation complete, false if not
     */
    updateDMA(channel)
    {
        if (!channel.fError && --channel.count >= 0) {
            if (channel.mode & ChipSet.DMA_MODE.DECREMENT) {
                channel.addrCurrent[0]--;
                if (channel.addrCurrent[0] < 0) {
                    channel.addrCurrent[0] = 0xff;
                    channel.addrCurrent[1]--;
                    if (channel.addrCurrent[1] < 0) channel.addrCurrent[1] = 0xff;
                }
            } else {
                channel.addrCurrent[0]++;
                if (channel.addrCurrent[0] > 0xff) {
                    channel.addrCurrent[0] = 0x00;
                    channel.addrCurrent[1]++;
                    if (channel.addrCurrent[1] > 0xff) channel.addrCurrent[1] = 0x00;
                }
            }
            /*
             * In situations where an HDC DMA operation took too long, the Fixed Disk BIOS would give up, but the DMA operation would continue.
             *
             * TODO: Verify that the Fixed Disk BIOS shuts down (ie, re-masks) a DMA channel for failed requests, and that this handles those failures.
             */
            if (!channel.masked) return false;
        }

        var controller = channel.controller;
        var iDMAChannel = controller.nChannelBase + channel.iChannel;
        controller.bStatus = (controller.bStatus & ~(0x10 << channel.iChannel)) | (0x1 << channel.iChannel);

        /*
         * EOP is supposed to automatically (re)mask the channel, unless it's set for auto-initialize.
         */
        if (!(channel.mode & ChipSet.DMA_MODE.AUTOINIT)) {
            channel.masked = true;
            channel.component = channel.obj = null;
        }

        if (DEBUG && this.messageEnabled(this.messageBitsDMA(iDMAChannel)) && channel.type == ChipSet.DMA_MODE.TYPE_WRITE && channel.sAddrDebug) {
            this.printMessage("updateDMA(" + iDMAChannel + ") transferred " + channel.cbDebug + " bytes to " + channel.sAddrDebug, true);
            this.dbg.doDump(["db", channel.sAddrDebug, 'l', channel.cbDebug]);
        }

        if (channel.done) {
            channel.done(!channel.fError);
            channel.done = null;
        }

        /*
         * While it might make sense to call cpu.setDMA() here, it's simpler to let the CPU issue one more call
         * to chipset.checkDMA() and let the CPU update INTR.DMA on its own, based on the return value from checkDMA().
         */
        return true;
    }

    /**
     * inPICLo(iPIC, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIC
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inPICLo(iPIC, addrFrom)
    {
        var b = 0;
        var pic = this.aPICs[iPIC];
        if (pic.bOCW3 != null) {
            var bReadReg = pic.bOCW3 & ChipSet.PIC_LO.OCW3_READ_CMD;
            switch (bReadReg) {
                case ChipSet.PIC_LO.OCW3_READ_IRR:
                    b = pic.bIRR;
                    break;
                case ChipSet.PIC_LO.OCW3_READ_ISR:
                    b = pic.bISR;
                    break;
                default:
                    break;
            }
        }
        if (this.messageEnabled(Messages.PIC | Messages.PORT | Messages.CHIPSET)) {
            this.printMessageIO(pic.port, null, addrFrom, "PIC" + iPIC, b, true);
        }
        return b;
    }

    /**
     * outPICLo(iPIC, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIC
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outPICLo(iPIC, bOut, addrFrom)
    {
        var pic = this.aPICs[iPIC];
        if (this.messageEnabled(Messages.PIC | Messages.PORT | Messages.CHIPSET)) {
            this.printMessageIO(pic.port, bOut, addrFrom, "PIC" + iPIC, null, true);
        }
        if (bOut & ChipSet.PIC_LO.ICW1) {
            /*
             * This must be an ICW1...
             */
            pic.nICW = 0;
            pic.aICW[pic.nICW++] = bOut;
            /*
             * I used to do the rest of this initialization in outPICHi(), once all the ICW commands had been received,
             * but a closer reading of the 8259A spec indicates that that should happen now, on receipt on ICW1.
             *
             * Also, on p.10 of that spec, it says "The Interrupt Mask Register is cleared".  I originally took that to
             * mean that all interrupts were masked, but based on what MS-DOS 4.0M expects to happen after this code runs:
             *
             *      0070:44C6 B013          MOV      AL,13
             *      0070:44C8 E620          OUT      20,AL
             *      0070:44CA B050          MOV      AL,50
             *      0070:44CC E621          OUT      21,AL
             *      0070:44CE B009          MOV      AL,09
             *      0070:44D0 E621          OUT      21,AL
             *
             * (ie, it expects its next call to INT 0x13 will still generate an interrupt), I've decided the spec
             * must be read literally, meaning that all IMR bits must be zeroed.  Unmasking all possible interrupts by
             * default seems unwise to me, but who am I to judge....
             */
            pic.bIMR = 0x00;
            pic.bIRLow = 7;
            /*
             * TODO: I'm also zeroing both IRR and ISR, even though that's not actually mentioned as part of the ICW
             * sequence, because they need to be (re)initialized at some point.  However, if some component is currently
             * requesting an interrupt, what should I do about that?  Originally, I had decided to clear them ONLY if they
             * were still undefined, but that change appeared to break the ROM BIOS handling of CTRL-ALT-DEL, so I'm back
             * to unconditionally zeroing them.
             */
            pic.bIRR = pic.bISR = 0;
            /*
             * The spec also says that "Special Mask Mode is cleared and Status Read is set to IRR".  I attempt to insure
             * the latter, but as for special mask mode... well, that mode isn't supported yet.
             */
            pic.bOCW3 = ChipSet.PIC_LO.OCW3 | ChipSet.PIC_LO.OCW3_READ_IRR;
        }
        else if (!(bOut & ChipSet.PIC_LO.OCW3)) {
            /*
             * This must be an OCW2...
             */
            var bOCW2 = bOut & ChipSet.PIC_LO.OCW2_OP_MASK;
            if (bOCW2 & ChipSet.PIC_LO.OCW2_EOI) {
                /*
                 * This OCW2 must be an EOI command...
                 */
                var nIRL, bIREnd = 0;
                if ((bOCW2 & ChipSet.PIC_LO.OCW2_EOI_SPEC) == ChipSet.PIC_LO.OCW2_EOI_SPEC) {
                    /*
                     * More "specifically", a specific EOI command...
                     */
                    nIRL = bOut & ChipSet.PIC_LO.OCW2_IR_LVL;
                    bIREnd = 1 << nIRL;
                } else {
                    /*
                     * Less "specifically", a non-specific EOI command.  The search for the highest priority in-service
                     * interrupt must start with whichever interrupt is opposite the lowest priority interrupt (normally 7,
                     * but technically whatever bIRLow is currently set to).  For example:
                     *
                     *      If bIRLow is 7, then the priority order is: 0, 1, 2, 3, 4, 5, 6, 7.
                     *      If bIRLow is 6, then the priority order is: 7, 0, 1, 2, 3, 4, 5, 6.
                     *      If bIRLow is 5, then the priority order is: 6, 7, 0, 1, 2, 3, 4, 5.
                     *      etc.
                     */
                    nIRL = pic.bIRLow + 1;
                    while (true) {
                        nIRL &= 0x7;
                        var bIR = 1 << nIRL;
                        if (pic.bISR & bIR) {
                            bIREnd = bIR;
                            break;
                        }
                        if (nIRL++ == pic.bIRLow) break;
                    }
                    if (DEBUG && !bIREnd) nIRL = null;      // for unexpected non-specific EOI commands, there's no IRQ to report
                }
                var nIRQ = (nIRL == null? undefined : pic.nIRQBase + nIRL);
                if (pic.bISR & bIREnd) {
                    if (DEBUG && this.messageEnabled(this.messageBitsIRQ(nIRQ))) {
                        this.printMessage("outPIC" + iPIC + '(' + Str.toHexByte(pic.port) + "): IRQ " + nIRQ + " ending @" + this.dbg.toHexOffset(this.cpu.getIP(), this.cpu.getCS()) + " stack=" + this.dbg.toHexOffset(this.cpu.getSP(), this.cpu.getSS()), true);
                    }
                    pic.bISR &= ~bIREnd;
                    this.checkIRR();
                } else {
                    if (DEBUG && this.messageEnabled(Messages.PIC | Messages.WARN)) {
                        this.printMessage("outPIC" + iPIC + '(' + Str.toHexByte(pic.port) + "): unexpected EOI for IRQ " + nIRQ, true, true);
                        if (MAXDEBUG) this.dbg.stopCPU();
                    }
                }
                /*
                 * TODO: Support EOI commands with automatic rotation (eg, ChipSet.PIC_LO.OCW2_EOI_ROT and ChipSet.PIC_LO.OCW2_EOI_ROTSPEC)
                 */
                if (bOCW2 & ChipSet.PIC_LO.OCW2_SET_ROTAUTO) {
                    if (this.messageEnabled(/*Messages.PIC | */Messages.WARN)) {
                        this.printMessage("PIC" + iPIC + '(' + Str.toHexByte(pic.port) + "): unsupported OCW2 rotate " + Str.toHexByte(bOut), true, true);
                    }
                }
            }
            else  if (bOCW2 == ChipSet.PIC_LO.OCW2_SET_PRI) {
                /*
                 * This OCW2 changes the lowest priority interrupt to the specified level (the default is 7)
                 */
                pic.bIRLow = bOut & ChipSet.PIC_LO.OCW2_IR_LVL;
            }
            else {
                /*
                 * TODO: Remaining commands to support: ChipSet.PIC_LO.OCW2_SET_ROTAUTO and ChipSet.PIC_LO.OCW2_CLR_ROTAUTO
                 */
                if (this.messageEnabled(/*Messages.PIC | */Messages.WARN)) {
                    this.printMessage("PIC" + iPIC + '(' + Str.toHexByte(pic.port) + "): unsupported OCW2 automatic EOI " + Str.toHexByte(bOut), true, true);
                }
            }
        } else {
            /*
             * This must be an OCW3 request. If it's a "Read Register" command (PIC_LO.OCW3_READ_CMD), inPICLo() will take care it.
             *
             * TODO: If OCW3 specified a "Poll" command (PIC_LO.OCW3_POLL_CMD) or a "Special Mask Mode" command (PIC_LO.OCW3_SMM_CMD),
             * that's unfortunate, because I don't support them yet.
             */
            if (bOut & (ChipSet.PIC_LO.OCW3_POLL_CMD | ChipSet.PIC_LO.OCW3_SMM_CMD)) {
                if (this.messageEnabled(/*Messages.PIC | */Messages.WARN)) {
                    this.printMessage("PIC" + iPIC + '(' + Str.toHexByte(pic.port) + "): unsupported OCW3 " + Str.toHexByte(bOut), true, true);
                }
            }
            pic.bOCW3 = bOut;
        }
    }

    /**
     * inPICHi(iPIC, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIC
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inPICHi(iPIC, addrFrom)
    {
        var pic = this.aPICs[iPIC];
        var b = pic.bIMR;
        if (this.messageEnabled(Messages.PIC | Messages.PORT | Messages.CHIPSET)) {
            this.printMessageIO(pic.port+1, null, addrFrom, "PIC" + iPIC, b, true);
        }
        return b;
    }

    /**
     * outPICHi(iPIC, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIC
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outPICHi(iPIC, bOut, addrFrom)
    {
        var pic = this.aPICs[iPIC];
        if (this.messageEnabled(Messages.PIC | Messages.PORT | Messages.CHIPSET)) {
            this.printMessageIO(pic.port+1, bOut, addrFrom, "PIC" + iPIC, null, true);
        }
        if (pic.nICW < pic.aICW.length) {
            pic.aICW[pic.nICW++] = bOut;
            if (pic.nICW == 2 && (pic.aICW[0] & ChipSet.PIC_LO.ICW1_SNGL))
                pic.nICW++;
            if (pic.nICW == 3 && !(pic.aICW[0] & ChipSet.PIC_LO.ICW1_ICW4))
                pic.nICW++;
        }
        else {
            /*
             * We have all our ICW "words" (ie, bytes), so this must be an OCW1 write (which is simply an IMR write)
             */
            pic.bIMR = bOut;
            /*
             * See the CPU's delayINTR() function for an explanation of why this explicit delay is necessary.
             */
            this.cpu.delayINTR();
            /*
             * Alas, we need a longer delay for the MODEL_5170's "KBD_RESET" function (F000:17D2), which must drop
             * into a loop and decrement CX at least once after unmasking the KBD IRQ.  The "KBD_RESET" function on
             * previous models could be handled with a 4-instruction delay provided by the Keyboard.resetDevice() call
             * to setIRR(), but the MODEL_5170 needs a roughly 6-instruction delay after it unmasks the KBD IRQ.
             */
            this.checkIRR(!iPIC && bOut == 0xFD? 6 : 0);
        }
    }

    /**
     * checkIMR(nIRQ)
     *
     * @this {ChipSet}
     * @param {number} nIRQ
     * @return {boolean} true if the specified IRQ is masked, false if not
     */
    checkIMR(nIRQ)
    {
        var iPIC = nIRQ >> 3;
        var nIRL = nIRQ & 0x7;
        var pic = this.aPICs[iPIC];
        return !!(pic.bIMR & (0x1 << nIRL));
    }

    /**
     * setIRR(nIRQ, nDelay)
     *
     * @this {ChipSet}
     * @param {number} nIRQ (IRQ 0-7 implies iPIC 0, and IRQ 8-15 implies iPIC 1)
     * @param {number} [nDelay] is an optional number of instructions to delay acknowledgment of the IRQ (see getIRRVector)
     */
    setIRR(nIRQ, nDelay)
    {
        var iPIC = nIRQ >> 3;
        var nIRL = nIRQ & 0x7;
        var pic = this.aPICs[iPIC];
        var bIRR = (1 << nIRL);
        if (!(pic.bIRR & bIRR)) {
            pic.bIRR |= bIRR;
            if (DEBUG && this.messageEnabled(this.messageBitsIRQ(nIRQ) | Messages.CHIPSET)) {
                this.printMessage("setIRR(" + nIRQ + ")", true);
            }
            pic.nDelay = nDelay || 0;
            this.checkIRR();
        }
    }

    /**
     * clearIRR(nIRQ)
     *
     * @this {ChipSet}
     * @param {number} nIRQ (IRQ 0-7 implies iPIC 0, and IRQ 8-15 implies iPIC 1)
     */
    clearIRR(nIRQ)
    {
        var iPIC = nIRQ >> 3;
        var nIRL = nIRQ & 0x7;
        var pic = this.aPICs[iPIC];
        var bIRR = (1 << nIRL);
        if (pic.bIRR & bIRR) {
            pic.bIRR &= ~bIRR;
            if (DEBUG && this.messageEnabled(this.messageBitsIRQ(nIRQ) | Messages.CHIPSET)) {
                this.printMessage("clearIRR(" + nIRQ + ")", true);
            }
            this.checkIRR();
        }
    }

    /**
     * checkIRR(nDelay)
     *
     * @this {ChipSet}
     * @param {number} [nDelay] is an optional number of instructions to delay acknowledgment of a pending interrupt
     */
    checkIRR(nDelay)
    {
        /*
         * Look for any IRR bits that aren't masked and aren't already in service; in theory, all we'd have to
         * check is the master PIC (which is the *only* PIC on pre-5170 models), because when any IRQs are set or
         * cleared on the slave, that would automatically be reflected in IRQ.SLAVE on the master; that's what
         * setIRR() and clearIRR() used to do.
         *
         * Unfortunately, despite setIRR() and clearIRR()'s efforts, whenever a slave interrupt is acknowledged,
         * getIRRVector() ends up clearing the IRR bits for BOTH the slave's IRQ and the master's IRQ.SLAVE.
         * So if another lower-priority slave IRQ is waiting to be dispatched, that fact is no longer reflected
         * in IRQ.SLAVE.
         *
         * Since checkIRR() is called on every EOI, we can resolve that problem here, by first checking the slave
         * PIC for any unmasked, unserviced interrupts and updating the master's IRQ.SLAVE.
         *
         * And since this is ALSO called by both setIRR() and clearIRR(), those functions no longer need to perform
         * their own IRQ.SLAVE updates.  This function consolidates the propagation of slave interrupts to the master.
         */
        var pic;
        var bIR = -1;

        if (this.cPICs > 1) {
            pic = this.aPICs[1];
            bIR = ~(pic.bISR | pic.bIMR) & pic.bIRR;
        }

        pic = this.aPICs[0];

        if (bIR >= 0) {
            if (bIR) {
                pic.bIRR |= (1 << ChipSet.IRQ.SLAVE);
            } else {
                pic.bIRR &= ~(1 << ChipSet.IRQ.SLAVE);
            }
        }

        bIR = ~(pic.bISR | pic.bIMR) & pic.bIRR;

        this.cpu.updateINTR(!!bIR);

        if (bIR && nDelay) pic.nDelay = nDelay;
    }

    /**
     * getIRRVector()
     *
     * getIRRVector() is called by the CPU whenever PS_IF is set and OP_NOINTR is clear.  Ordinarily, an immediate
     * response would seem perfectly reasonable, but unfortunately, there are places in the original ROM BIOS like
     * "KBD_RESET" (F000:E688) that enable interrupts but still expect nothing to happen for several more instructions.
     *
     * So, in addition to the two normal responses (an IDT vector #, or -1 indicating no pending interrupts), we must
     * support a third response (-2) that basically means: don't change the CPU interrupt state, just keep calling until
     * we return one of the first two responses.  The number of times we delay our normal response is determined by the
     * component that originally called setIRR with an optional delay parameter.
     *
     * @this {ChipSet}
     * @param {number} [iPIC]
     * @return {number} IDT vector # of the next highest-priority interrupt, -1 if none, or -2 for "please try your call again later"
     */
    getIRRVector(iPIC)
    {
        if (iPIC === undefined) iPIC = 0;

        /*
         * Look for any IRR bits that aren't masked and aren't already in service...
         */
        var nIDT = -1;
        var pic = this.aPICs[iPIC];
        if (!pic.nDelay) {
            var bIR = pic.bIRR & ((pic.bISR | pic.bIMR) ^ 0xff);
            /*
             * The search for the next highest priority requested interrupt (that's also not in-service and not masked)
             * must start with whichever interrupt is opposite the lowest priority interrupt (normally 7, but technically
             * whatever bIRLow is currently set to).  For example:
             *
             *      If bIRLow is 7, then the priority order is: 0, 1, 2, 3, 4, 5, 6, 7.
             *      If bIRLow is 6, then the priority order is: 7, 0, 1, 2, 3, 4, 5, 6.
             *      If bIRLow is 5, then the priority order is: 6, 7, 0, 1, 2, 3, 4, 5.
             *      etc.
             *
             * This process is similar to the search performed by non-specific EOIs, except those apply only to a single
             * PIC (which is why a slave interrupt must be EOI'ed twice: once for the slave PIC and again for the master),
             * whereas here we must search across all PICs.
             */
            var nIRL = pic.bIRLow + 1;
            while (true) {

                nIRL &= 0x7;
                var bIRNext = 1 << nIRL;

                /*
                 * If we encounter an interrupt that's still in-service BEFORE we encounter a requested interrupt,
                 * then we're done; we must allow a higher priority in-service interrupt to finish before acknowledging
                 * any lower priority interrupts.
                 */
                if (pic.bISR & bIRNext) break;

                if (bIR & bIRNext) {

                    if (!iPIC && nIRL == ChipSet.IRQ.SLAVE) {
                        /*
                         * Slave interrupts are tied to the master PIC on IRQ2; query the slave PIC for the vector #
                         */
                        nIDT = this.getIRRVector(1);
                    } else {
                        /*
                         * Get the starting IDT vector # from ICW2 and add the IR level to obtain the target IDT vector #
                         */
                        nIDT = pic.aICW[1] + nIRL;
                    }

                    if (nIDT >= 0) {
                        pic.bISR |= bIRNext;

                        /*
                         * Setting the ISR implies clearing the IRR, but clearIRR() has side-effects we don't want
                         * (eg, clearing the slave IRQ, notifying the CPU, etc), so we clear the IRR ourselves.
                         */
                        pic.bIRR &= ~bIRNext;

                        var nIRQ = pic.nIRQBase + nIRL;
                        if (DEBUG && this.messageEnabled(this.messageBitsIRQ(nIRQ))) {
                            this.printMessage("getIRRVector(): IRQ " + nIRQ + " interrupting stack " + this.dbg.toHexOffset(this.cpu.getSP(), this.cpu.getSS()), true, true);
                        }
                        if (MAXDEBUG && DEBUGGER) {
                            this.acInterrupts[nIRQ]++;
                        }
                    }
                    break;
                }

                if (nIRL++ == pic.bIRLow) break;
            }
        } else {
            nIDT = -2;
            pic.nDelay--;
        }
        return nIDT;
    }

    /**
     * setFPUInterrupt()
     *
     * @this {ChipSet}
     */
    setFPUInterrupt()
    {
        if (this.model >= ChipSet.MODEL_5170) {
            this.setIRR(ChipSet.IRQ.FPU);
        } else {
            /*
             * TODO: Determine whether we need to maintain an "Active NMI" state; ie, if NMI.DISABLE is cleared
             * later, and the FPU coprocessor is still indicating an error condition, should we then generate an NMI?
             */
            if (!(this.bNMI & ChipSet.NMI.DISABLE)) {
                X86.helpInterrupt.call(this.cpu, X86.EXCEPTION.NMI);
            }
        }
    }

    /**
     * clearFPUInterrupt(fSet)
     *
     * @this {ChipSet}
     */
    clearFPUInterrupt()
    {
        if (this.model >= ChipSet.MODEL_5170) {
            this.clearIRR(ChipSet.IRQ.FPU);
        } else {
            /*
             * TODO: If we maintain an "Active NMI" state, then we will need code here to clear that state, as well
             * as code in outNMI() to clear that state and generate an NMI as needed.
             */
        }
    }

    /**
     * inTimer(iPIT, iPITTimer, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIT (0 or 1)
     * @param {number} iPITTimer (0, 1, or 2)
     * @param {number} port (0x40, 0x41, 0x42, etc)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inTimer(iPIT, iPITTimer, port, addrFrom)
    {
        var b;
        var iBaseTimer = (iPIT? 3 : 0);
        var timer = this.aTimers[iBaseTimer + iPITTimer];

        if (timer.fStatusLatched) {
            b = timer.bStatus;
            timer.fStatusLatched = false;
        }
        else {
            if (timer.countIndex == timer.countBytes) {
                this.resetTimerIndex(iBaseTimer + iPITTimer);
            }
            if (timer.fCountLatched) {
                b = timer.countLatched[timer.countIndex++];
                if (timer.countIndex == timer.countBytes) {
                    timer.fCountLatched = false
                }
            }
            else {
                this.updateTimer(iBaseTimer + iPITTimer);
                b = timer.countCurrent[timer.countIndex++];
            }
        }
        if (this.messageEnabled(Messages.TIMER | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "PIT" + iPIT + ".TIMER" + iPITTimer, b, true);
        }
        return b;
    }

    /**
     * outTimer(iPIT, iPITTimer, port, bOut, addrFrom)
     *
     * We now rely EXCLUSIVELY on setBurstCycles() to address situations where quick timer interrupt turn-around
     * is expected; eg, by the ROM BIOS POST when it sets TIMER0 to a low test count (0x16); since we typically
     * don't update any of the timers until after we've finished a burst of CPU cycles, we must reduce the current
     * burst cycle count, so that the current instruction burst will end at the same time a timer interrupt is expected.
     *
     * Note that in some cases, if the number of cycles remaining in the current burst is less than the target,
     * this may have the effect of *lengthening* the current burst instead of shortening it, but stepCPU() should be
     * OK with that.
     *
     * @this {ChipSet}
     * @param {number} iPIT (0 or 1)
     * @param {number} iPITTimer (0, 1, or 2)
     * @param {number} port (0x40, 0x41, 0x42, etc)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outTimer(iPIT, iPITTimer, port, bOut, addrFrom)
    {
        if (this.messageEnabled(Messages.TIMER | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "PIT" + iPIT + ".TIMER" + iPITTimer, null, true);
        }

        var iBaseTimer = (iPIT? 3 : 0);
        var timer = this.aTimers[iBaseTimer + iPITTimer];

        if (timer.countIndex == timer.countBytes) {
            this.resetTimerIndex(iBaseTimer + iPITTimer);
        }

        timer.countInit[timer.countIndex++] = bOut;

        if (timer.countIndex == timer.countBytes) {
            /*
             * In general, writing a new count to a timer that's already counting isn't supposed to affect the current
             * count, with the notable exceptions of MODE0 and MODE4.
             */
            if (!timer.fCounting || timer.mode == ChipSet.PIT_CTRL.MODE0 || timer.mode == ChipSet.PIT_CTRL.MODE4) {
                timer.fCountLatched = false;
                timer.countCurrent[0] = timer.countStart[0] = timer.countInit[0];
                timer.countCurrent[1] = timer.countStart[1] = timer.countInit[1];
                timer.nCyclesStart = this.cpu.getCycles(this.fScaleTimers);
                timer.fCounting = true;

                /*
                 * I believe MODE0 is the only mode where OUT (fOUT) starts out low (false); for the rest of the modes,
                 * OUT (fOUT) starts high (true).  It's also my understanding that the way edge-triggered interrupts work
                 * on the original PC is that an interrupt is requested only when the corresponding OUT transitions from
                 * low to high.
                 */
                timer.fOUT = (timer.mode != ChipSet.PIT_CTRL.MODE0);

                if (iPIT == ChipSet.PIT0.INDEX && iPITTimer == ChipSet.PIT0.TIMER0) {
                    /*
                     * TODO: Determine if there are situations/modes where I should NOT automatically clear IRQ0 on behalf of TIMER0.
                     */
                    this.clearIRR(ChipSet.IRQ.TIMER0);
                    var countInit = this.getTimerInit(ChipSet.PIT0.TIMER0);
                    var nCyclesRemain = (countInit * this.nTicksDivisor) | 0;
                    if (timer.mode == ChipSet.PIT_CTRL.MODE3) nCyclesRemain >>= 1;
                    this.cpu.setBurstCycles(nCyclesRemain);
                }
            }

            if (iPIT == ChipSet.PIT0.INDEX && iPITTimer == ChipSet.PIT0.TIMER2) this.setSpeaker();
        }
    }

    /**
     * inTimerCtrl(iPIT, port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIT (0 or 1)
     * @param {number} port (0x43 or 0x4B)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number|null} simulated port value
     */
    inTimerCtrl(iPIT, port, addrFrom)
    {
        this.printMessageIO(port, null, addrFrom, "PIT" + iPIT + ".CTRL", null, Messages.TIMER);
        /*
         * NOTE: Even though reads to port 0x43 are undefined (I think), I'm going to "define" it
         * as returning the last value written, purely for the Debugger's benefit.
         */
        return iPIT? this.bPIT1Ctrl : this.bPIT0Ctrl;
    }

    /**
     * outTimerCtrl(iPIT, port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iPIT (0 or 1)
     * @param {number} port (0x43)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outTimerCtrl(iPIT, port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "PIT" + iPIT + ".CTRL", null, Messages.TIMER);

        /*
         * Extract the SC (Select Counter) bits.
         */
        var iBaseTimer = 0;
        var iPITTimer = (bOut & ChipSet.PIT_CTRL.SC);
        if (!iPIT) {
            this.bPIT0Ctrl = bOut;
        } else {
            iBaseTimer = 3;
            this.bPIT1Ctrl = bOut;
        }

        /*
         * Check for the Read-Back command and process as needed.
         */
        if (iPITTimer == ChipSet.PIT_CTRL.SC_BACK) {
            if (!(bOut & ChipSet.PIT_CTRL.RB_STATUS)) {
                for (iPITTimer = 0; iPITTimer <= 2; iPITTimer++) {
                    if (bOut & (ChipSet.PIT_CTRL.RB_CTR0 << iPITTimer)) {
                        this.latchTimerStatus(iBaseTimer + iPITTimer);
                    }
                }
            }
            if (!(bOut & ChipSet.PIT_CTRL.RB_COUNTS)) {
                for (iPITTimer = 0; iPITTimer <= 2; iPITTimer++) {
                    if (bOut & (ChipSet.PIT_CTRL.RB_CTR0 << iPITTimer)) {
                        this.latchTimerCount(iBaseTimer + iPITTimer);
                    }
                }
            }
            return;
        }

        /*
         * Convert the SC (Select Counter) bits into an iPITTimer index (0-2).
         */
        iPITTimer >>= ChipSet.PIT_CTRL.SC_SHIFT;

        /*
         * Extract BCD (bit 0), MODE (bits 1-3), and RW (bits 4-5), which we simply store as-is (see setTimerMode).
         */
        var bcd = (bOut & ChipSet.PIT_CTRL.BCD);
        var mode = (bOut & ChipSet.PIT_CTRL.MODE);
        var rw = (bOut & ChipSet.PIT_CTRL.RW);

        if (rw == ChipSet.PIT_CTRL.RW_LATCH) {
            /*
             * Of all the RW bit combinations, this is the only one that "countermands" normal control register
             * processing (the BCD and MODE bits are "don't care").
             */
            this.latchTimerCount(iBaseTimer + iPITTimer);
        }
        else {
            this.setTimerMode(iBaseTimer + iPITTimer, bcd, mode, rw);

            /*
             * The 5150 ROM BIOS code @F000:E285 ("TEST.7") would fail after a warm boot (eg, after a CTRL-ALT-DEL) because
             * it assumed that no TIMER0 interrupt would occur between the point it unmasked the TIMER0 interrupt and the
             * point it started reprogramming TIMER0.
             *
             * Similarly, the 5160 ROM BIOS @F000:E35D ("8253 TIMER CHECKOUT") would fail after initializing the EGA BIOS,
             * because the EGA BIOS uses TIMER0 during its diagnostics; as in the previous example, by the time the 8253
             * test code runs later, there's now a pending TIMER0 interrupt, which triggers an interrupt as soon as IRQ0 is
             * unmasked @F000:E364.
             *
             * After looking at this problem at bit more closely the second time around (while debugging the EGA BIOS),
             * it turns out I missed an important 8253 feature: whenever a new MODE0 control word OR a new MODE0 count
             * is written, fOUT (which is what drives IRQ0) goes low.  So, by simply adding an appropriate clearIRR() call
             * both here and in outTimer(), this annoying problem seems to be gone.
             *
             * TODO: Determine if there are situations/modes where I should NOT automatically clear IRQ0 on behalf of TIMER0.
             */
            if (iPIT == ChipSet.PIT0.INDEX && iPITTimer == ChipSet.PIT0.TIMER0) this.clearIRR(ChipSet.IRQ.TIMER0);

            /*
             * Another TIMER0 HACK: The "CASSETTE DATA WRAP TEST" @F000:E51E occasionally reports an error when the second of
             * two TIMER0 counts it latches is greater than the first.  You would think the ROM BIOS would expect this, since
             * TIMER0 can reload its count at any time.  Is the ROM BIOS assuming that TIMER0 was initialized sufficiently
             * recently that this should never happen?  I'm not sure, but for now, let's try resetting TIMER0's count immediately
             * after TIMER2 has been reprogrammed for the test in question (ie, when interrupts are masked and PPIB is set as
             * shown below).
             *
             * FWIW, I believe the cassette hardware was discontinued after MODEL_5150, and even if the test fails, it's non-fatal;
             * the ROM BIOS displays an error (131) and moves on.
             */
            if (iPIT == ChipSet.PIT0.INDEX && iPITTimer == ChipSet.PIT0.TIMER2) {
                var pic = this.aPICs[0];
                if (pic.bIMR == 0xff && this.bPPIB == (ChipSet.PPI_B.CLK_TIMER2 | ChipSet.PPI_B.ENABLE_SW2 | ChipSet.PPI_B.CASS_MOTOR_OFF | ChipSet.PPI_B.CLK_KBD)) {
                    var timer = this.aTimers[0];
                    timer.countStart[0] = timer.countInit[0];
                    timer.countStart[1] = timer.countInit[1];
                    timer.nCyclesStart = this.cpu.getCycles(this.fScaleTimers);
                    if (DEBUG && this.messageEnabled(Messages.TIMER)) {
                        this.printMessage("PIT0.TIMER0 count reset @" + timer.nCyclesStart + " cycles", true);
                    }
                }
            }
        }
    }

    /**
     * getTimerInit(iTimer)
     *
     * @this {ChipSet}
     * @param {number} iTimer
     * @return {number} initial timer count
     */
    getTimerInit(iTimer)
    {
        var timer = this.aTimers[iTimer];
        var countInit = (timer.countInit[1] << 8) | timer.countInit[0];
        if (!countInit) countInit = (timer.countBytes == 1? 0x100 : 0x10000);
        return countInit;
    }

    /**
     * getTimerStart(iTimer)
     *
     * @this {ChipSet}
     * @param {number} iTimer
     * @return {number} starting timer count (from the initial timer count for the current countdown)
     */
    getTimerStart(iTimer)
    {
        var timer = this.aTimers[iTimer];
        var countStart = (timer.countStart[1] << 8) | timer.countStart[0];
        if (!countStart) countStart = (timer.countBytes == 1? 0x100 : 0x10000);
        return countStart;
    }

    /**
     * getTimerCycleLimit(iTimer, nCycles)
     *
     * This is called by the CPU to determine the maximum number of cycles it can process for the current burst.
     * It's presumed that no instructions have been executed since the last updateTimer(iTimer) call.
     *
     * @this {ChipSet}
     * @param {number} iTimer
     * @param {number} nCycles desired
     * @return {number} maximum number of cycles remaining for the specified timer (<= nCycles)
     */
    getTimerCycleLimit(iTimer, nCycles)
    {
        var timer = this.aTimers[iTimer];
        if (timer.fCounting) {
            var nCyclesUpdate = this.cpu.getCycles(this.fScaleTimers);
            var ticksElapsed = ((nCyclesUpdate - timer.nCyclesStart) / this.nTicksDivisor) | 0;
            // DEBUG: this.assert(ticksElapsed >= 0);
            var countStart = this.getTimerStart(iTimer);
            var count = countStart - ticksElapsed;
            if (timer.mode == ChipSet.PIT_CTRL.MODE3) count -= ticksElapsed;
            // DEBUG: this.assert(count > 0);
            var nCyclesRemain = (count * this.nTicksDivisor) | 0;
            if (timer.mode == ChipSet.PIT_CTRL.MODE3) nCyclesRemain >>= 1;
            if (nCycles > nCyclesRemain) nCycles = nCyclesRemain;
        }
        return nCycles;
    }

    /**
     * latchTimerCount(iTimer)
     *
     * @this {ChipSet}
     * @param {number} iTimer
     */
    latchTimerCount(iTimer)
    {
        /*
         * Update the timer's current count.
         */
        this.updateTimer(iTimer);

        /*
         * Now we can latch it.
         */
        var timer = this.aTimers[iTimer];
        timer.countLatched[0] = timer.countCurrent[0];
        timer.countLatched[1] = timer.countCurrent[1];
        timer.fCountLatched = true;

        /*
         * VERIFY: That a latch request resets the timer index.
         */
        this.resetTimerIndex(iTimer);
    }

    /**
     * latchTimerStatus(iTimer)
     *
     * @this {ChipSet}
     * @param {number} iTimer
     */
    latchTimerStatus(iTimer)
    {
        var timer = this.aTimers[iTimer];
        if (!timer.fStatusLatched) {
            this.updateTimer(iTimer);
            timer.bStatus = timer.bcd | timer.mode | timer.rw | (timer.countIndex < timer.countBytes? ChipSet.PIT_CTRL.RB_NULL : 0) | (timer.fOUT? ChipSet.PIT_CTRL.RB_OUT : 0);
            timer.fStatusLatched = true;
        }
    }

    /**
     * setTimerMode(iTimer, bcd, mode, rw)
     *
     * FYI: After setting a timer's mode, the CPU must set the timer's count before it becomes operational;
     * ie, before fCounting becomes true.
     *
     * @this {ChipSet}
     * @param {number} iTimer
     * @param {number} bcd
     * @param {number} mode
     * @param {number} rw
     */
    setTimerMode(iTimer, bcd, mode, rw)
    {
        var timer = this.aTimers[iTimer];
        timer.rw = rw;
        timer.mode = mode;
        timer.bcd = bcd;
        timer.countInit = [0, 0];
        timer.countCurrent = [0, 0];
        timer.countLatched = [0, 0];
        timer.fOUT = false;
        timer.fCountLatched = false;
        timer.fCounting = false;
        timer.fStatusLatched = false;
        this.resetTimerIndex(iTimer);
    }

    /**
     * resetTimerIndex(iTimer)
     *
     * @this {ChipSet}
     * @param {number} iTimer
     */
    resetTimerIndex(iTimer)
    {
        var timer = this.aTimers[iTimer];
        timer.countIndex = (timer.rw == ChipSet.PIT_CTRL.RW_MSB? 1 : 0);
        timer.countBytes = (timer.rw == ChipSet.PIT_CTRL.RW_BOTH? 2 : 1);
    }

    /**
     * updateTimer(iTimer, fCycleReset)
     *
     * updateTimer() calculates and updates a timer's current count purely on an "on-demand" basis; we don't
     * actually adjust timer counters every 4 CPU cycles on a 4.77Mhz PC, since updating timers that frequently
     * would be prohibitively slow.  If you're single-stepping the CPU, then yes, updateTimer() will be called
     * after every stepCPU(), via updateAllTimers(), but if we're doing our job correctly here, the frequency
     * of calls to updateTimer() should not affect timer counts across otherwise identical runs.
     *
     * TODO: Implement support for all TIMER modes, and verify that all the modes currently implemented are
     * "up to spec"; they're close enough to make the ROM BIOS happy, but beyond that, I've done very little.
     *
     * @this {ChipSet}
     * @param {number} iTimer
     *      0: Time-of-Day interrupt (~18.2 interrupts/second)
     *      1: DMA refresh
     *      2: Sound/Cassette
     * @param {boolean} [fCycleReset] is true if a cycle-count reset is about to occur
     * @return {Object} timer
     */
    updateTimer(iTimer, fCycleReset)
    {
        var timer = this.aTimers[iTimer];

        /*
         * Every timer's counting state is gated by its own fCounting flag; TIMER2 is further gated by PPI_B's
         * CLK_TIMER2 bit.
         */
        if (timer.fCounting && (iTimer != ChipSet.PIT0.TIMER2 || (this.bPPIB & ChipSet.PPI_B.CLK_TIMER2))) {
            /*
             * We determine the current timer count based on how many instruction cycles have elapsed since we started
             * the timer.  Timers are supposed to be "ticking" at a rate of 1193181.8181 times per second, which is
             * the system clock of 14.31818Mhz, divided by 12.
             *
             * Similarly, for an 8088, there are supposed to be 4.77Mhz instruction cycles per second, which comes from
             * the system clock of 14.31818Mhz, divided by 3.
             *
             * If we divide 4,772,727 CPU cycles per second by 1,193,181 ticks per second, we get 4 cycles per tick,
             * which agrees with the ratio of the clock divisors: 12 / 3 == 4.
             *
             * However, if getCycles() is being called with fScaleTimers == true AND the CPU is running faster than its
             * base cycles-per-second setting, then getCycles() will divide the cycle count by the CPU's cycle multiplier,
             * so that the timers fire with the same real-world frequency that the user expects.  However, that will
             * break any code (eg, the ROM BIOS diagnostics) that assumes that the timers are ticking once every 4 cycles
             * (or more like every 5 cycles on a 6Mhz 80286).
             *
             * So, when using a machine with the ChipSet "scaleTimers" property set, make sure you reset the machine's
             * speed prior to rebooting, otherwise you're likely to see ROM BIOS errors.  Ditto for any application code
             * that makes similar assumptions about the relationship between CPU and timer speeds.
             *
             * In general, you're probably better off NOT using the "scaleTimers" property, and simply allowing the timers
             * to tick faster as you increase CPU speed (which is why fScaleTimers defaults to false).
             */
            var nCycles = this.cpu.getCycles(this.fScaleTimers);

            /*
             * Instead of maintaining partial tick counts, we calculate a fresh countCurrent from countStart every
             * time we're called, using the cycle count recorded when the timer was initialized.  countStart is set
             * to countInit when fCounting is first set, and then it is refreshed from countInit at the expiration of
             * every count, so that if someone loaded a new countInit in the meantime (eg, BASICA), we'll pick it up.
             *
             * For the original MODEL_5170, the number of cycles per tick is approximately 6,000,000 / 1,193,181,
             * or 5.028575, so we can no longer always divide cycles by 4 with a simple right-shift by 2.  The proper
             * divisor (eg, 4 for MODEL_5150 and MODEL_5160, 5 for MODEL_5170, etc) is nTicksDivisor, which initBus()
             * calculates using the base CPU speed returned by cpu.getBaseCyclesPerSecond().
             */
            var ticksElapsed = ((nCycles - timer.nCyclesStart) / this.nTicksDivisor) | 0;

            if (ticksElapsed < 0) {
                if (DEBUG && this.messageEnabled(Messages.TIMER)) {
                    this.printMessage("updateTimer(" + iTimer + "): negative tick count (" + ticksElapsed + ")", true);
                }
                timer.nCyclesStart = nCycles;
                ticksElapsed = 0;
            }

            var countInit = this.getTimerInit(iTimer);
            var countStart = this.getTimerStart(iTimer);

            var fFired = false;
            var count = countStart - ticksElapsed;

            /*
             * NOTE: This mode is used by ROM BIOS test code that wants to verify timer interrupts are arriving
             * neither too slowly nor too quickly.  As a result, I've had to add some corresponding trickery
             * in outTimer() to force interrupt simulation immediately after a low initial count (0x16) has been set.
             */
            if (timer.mode == ChipSet.PIT_CTRL.MODE0) {
                if (count <= 0) count = 0;
                if (DEBUG && this.messageEnabled(Messages.TIMER)) {
                    this.printMessage("updateTimer(" + iTimer + "): MODE0 timer count=" + count, true);
                }
                if (!count) {
                    timer.fOUT = true;
                    timer.fCounting = false;
                    if (!iTimer) {
                        fFired = true;
                        this.setIRR(ChipSet.IRQ.TIMER0);
                        if (MAXDEBUG && DEBUGGER) this.acTimersFired[iTimer]++;
                    }
                }
            }
            /*
             * Early implementation of this mode was minimal because when using this mode, the ROM BIOS simply wanted
             * to see the count changing; it wasn't looking for interrupts.  See ROM BIOS "TEST.03" code @F000:E0DE,
             * where TIMER1 is programmed for MODE2, LSB (the same settings, incidentally, used immediately afterward
             * for TIMER1 in conjunction with DMA channel 0 memory refreshes).
             *
             * Now this mode generates interrupts.  Note that OUT goes low when the count reaches 1, then high
             * one tick later, at which point the count is reloaded and counting continues.
             *
             * Chances are, we will often miss the exact point at which the count becomes 1 (or more importantly,
             * one tick later, when the count *would* become 0, since that's when OUT transitions from low to high),
             * but as with MODE3, hopefully no one will mind.
             *
             * FYI, technically, it appears that the count is never supposed to reach 0, and that an initial count of 1
             * is "illegal", whatever that means.
             */
            else if (timer.mode == ChipSet.PIT_CTRL.MODE2) {
                timer.fOUT = (count != 1);          // yes, this line does seem rather pointless....
                if (count <= 0) {
                    count = countInit + count;
                    if (count <= 0) {
                        /*
                         * TODO: Consider whether we ever care about TIMER1 or TIMER2 underflow
                         */
                        if (DEBUG && this.messageEnabled(Messages.TIMER) && !iTimer) {
                            this.printMessage("updateTimer(" + iTimer + "): mode=2, underflow=" + count, true);
                        }
                        count = countInit;
                    }
                    timer.countStart[0] = count & 0xff;
                    timer.countStart[1] = (count >> 8) & 0xff;
                    timer.nCyclesStart = nCycles;
                    if (!iTimer && timer.fOUT) {
                        fFired = true;
                        this.setIRR(ChipSet.IRQ.TIMER0);
                        if (MAXDEBUG && DEBUGGER) this.acTimersFired[iTimer]++;
                    }
                }
            }
            /*
             * NOTE: This is the normal mode for TIMER0, which the ROM BIOS uses to generate h/w interrupts roughly
             * 18.2 times per second.  In this mode, the count must be decremented twice as fast (hence the extra ticks
             * subtraction below, in addition to the subtraction above), but IRQ_TIMER0 is raised only on alternate
             * iterations; ie, only when fOUT transitions to true ("high").  The equal alternating fOUT states is why
             * this mode is referred to as "square wave" mode.
             *
             * TODO: Implement the correct behavior for this mode when the count is ODD.  In that case, fOUT is supposed
             * to be "high" for (N + 1) / 2 ticks and "low" for (N - 1) / 2 ticks.
             */
            else if (timer.mode == ChipSet.PIT_CTRL.MODE3) {
                count -= ticksElapsed;
                if (count <= 0) {
                    timer.fOUT = !timer.fOUT;
                    count = countInit + count;
                    if (count <= 0) {
                        /*
                         * TODO: Consider whether we ever care about TIMER1 or TIMER2 underflow
                         */
                        if (DEBUG && this.messageEnabled(Messages.TIMER) && !iTimer) {
                            this.printMessage("updateTimer(" + iTimer + "): mode=3, underflow=" + count, true);
                        }
                        count = countInit;
                    }
                    if (MAXDEBUG && DEBUGGER && !iTimer) {
                        var nCycleDelta = 0;
                        if (this.acTimer0Counts.length > 0) nCycleDelta = nCycles - this.acTimer0Counts[0][1];
                        this.acTimer0Counts.push([count, nCycles, nCycleDelta]);
                    }
                    timer.countStart[0] = count & 0xff;
                    timer.countStart[1] = (count >> 8) & 0xff;
                    timer.nCyclesStart = nCycles;
                    if (!iTimer && timer.fOUT) {
                        fFired = true;
                        this.setIRR(ChipSet.IRQ.TIMER0);
                        if (MAXDEBUG && DEBUGGER) this.acTimersFired[iTimer]++;
                    }
                }
            }

            if (DEBUG && this.messageEnabled(Messages.TIMER | Messages.LOG)) {
                this.log("TIMER" + iTimer + " count: " + count + ", ticks: " + ticksElapsed + ", fired: " + (fFired? "true" : "false"));
            }

            timer.countCurrent[0] = count & 0xff;
            timer.countCurrent[1] = (count >> 8) & 0xff;
            if (fCycleReset) this.nCyclesStart = 0;
        }
        return timer;
    }

    /**
     * updateAllTimers(fCycleReset)
     *
     * @this {ChipSet}
     * @param {boolean} [fCycleReset] is true if a cycle-count reset is about to occur
     */
    updateAllTimers(fCycleReset)
    {
        for (var iTimer = 0; iTimer < this.aTimers.length; iTimer++) {
            this.updateTimer(iTimer, fCycleReset);
        }
        if (this.model >= ChipSet.MODEL_5170) this.updateRTCTime();
    }

    /**
     * inPPIA(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x60)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inPPIA(port, addrFrom)
    {
        var b = this.bPPIA;
        if (this.bPPICtrl & ChipSet.PPI_CTRL.A_IN) {
            if (this.bPPIB & ChipSet.PPI_B.CLEAR_KBD) {
                b = this.aDIPSwitches[0][1];
            }
            else if (this.kbd) {
                b = this.kbd.readScanCode();
            }
        }
        this.printMessageIO(port, null, addrFrom, "PPI_A", b);
        return b;
    }

    /**
     * outPPIA(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x60)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outPPIA(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "PPI_A");
        this.bPPIA = bOut;
    }

    /**
     * inPPIB(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x61)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inPPIB(port, addrFrom)
    {
        var b = this.bPPIB;
        this.printMessageIO(port, null, addrFrom, "PPI_B", b);
        return b;
    }

    /**
     * outPPIB(port, bOut, addrFrom)
     *
     * This is the original (MODEL_5150 and MODEL_5160) handler for port 0x61.  Functionality common
     * to all models must be placed in updatePPIB().
     *
     * @this {ChipSet}
     * @param {number} port (0x61)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outPPIB(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "PPI_B");
        this.updatePPIB(bOut);
    }

    /**
     * updatePPIB(bOut)
     *
     * On MODEL_5170 and up, this updates the "simulated" PPI_B.  The only common (and well-documented) PPI_B bits
     * across all models are PPI_B.CLK_TIMER2 and PPI_B.SPK_TIMER2, so its possible that this function may need to
     * limit its updates to just those bits, and move any model-specific requirements back into the appropriate I/O
     * handlers (PPIB or 8042RWReg).  We'll see.
     *
     * UPDATE: The WOLF3D keyboard interrupt handler toggles the CLEAR_KBD bit of port 0x61 (ie, it sets and then
     * clears the bit) after reading the scan code from port 0x60; assuming that they use the same interrupt handler
     * for all machine models (which I haven't verified), the clear implication is that updatePPIB() also needs to
     * support CLEAR_KBD and CLK_KBD, so I've moved that code from outPPIB() to updatePPIB().
     *
     * @this {ChipSet}
     * @param {number} bOut
     */
    updatePPIB(bOut)
    {
        var fNewSpeaker = !!(bOut & ChipSet.PPI_B.SPK_TIMER2);
        var fOldSpeaker = !!(this.bPPIB & ChipSet.PPI_B.SPK_TIMER2);
        this.bPPIB = bOut;
        if (this.kbd) this.kbd.setEnabled(!(bOut & ChipSet.PPI_B.CLEAR_KBD), !!(bOut & ChipSet.PPI_B.CLK_KBD));
        if (fNewSpeaker != fOldSpeaker) {
            /*
             * Originally, this code didn't catch the "ERROR_BEEP" case @F000:EC34, which first turns both PPI_B.CLK_TIMER2 (0x01)
             * and PPI_B.SPK_TIMER2 (0x02) off, then turns on only PPI_B.SPK_TIMER2 (0x02), then restores the original port value.
             *
             * So, when the ROM BIOS keyboard buffer got full, we didn't issue a BEEP alert.  I've fixed that by limiting the test
             * to PPI_B.SPK_TIMER2 and ignoring PPI_B.CLK_TIMER2.
             */
            this.setSpeaker(fNewSpeaker);
        }
    }

    /**
     * inPPIC(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x62)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inPPIC(port, addrFrom)
    {
        var b = 0;

        /*
         * If you ever wanted to simulate I/O channel errors or R/W memory parity errors, you could
         * add either PPI_C.IO_CHANNEL_CHK (0x40) or PPI_C.RW_PARITY_CHK (0x80) to the return value (b).
         */
        if ((this.model|0) == ChipSet.MODEL_5150) {
            if (this.bPPIB & ChipSet.PPI_B.ENABLE_SW2) {
                b |= this.aDIPSwitches[1][1] & ChipSet.PPI_C.SW;
            } else {
                b |= (this.aDIPSwitches[1][1] >> 4) & 0x1;
            }
        } else {
            if (this.bPPIB & ChipSet.PPI_B.ENABLE_SW_HI) {
                b |= this.aDIPSwitches[0][1] >> 4;
            } else {
                b |= this.aDIPSwitches[0][1] & 0xf;
            }
        }

        if (this.bPPIB & ChipSet.PPI_B.CLK_TIMER2) {
            var timer = this.updateTimer(ChipSet.PIT0.TIMER2);
            if (timer.fOUT) {
                if (this.bPPIB & ChipSet.PPI_B.SPK_TIMER2)
                    b |= ChipSet.PPI_C.TIMER2_OUT;
                else
                    b |= ChipSet.PPI_C.CASS_DATA_IN;
            }
        }

        /*
         * The ROM BIOS polls this port incessantly during its memory tests, checking for memory parity errors
         * (which of course we never report), so we further restrict these port messages to Messages.MEM.
         */
        this.printMessageIO(port, null, addrFrom, "PPI_C", b, Messages.CHIPSET | Messages.MEM);
        return b;
    }

    /**
     * outPPIC(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x62)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    outPPIC(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "PPI_C");
        this.bPPIC = bOut;
    }

    /**
     * inPPICtrl(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x63)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inPPICtrl(port, addrFrom)
    {
        var b = this.bPPICtrl;
        this.printMessageIO(port, null, addrFrom, "PPI_CTRL", b);
        return b;
    }

    /**
     * outPPICtrl(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x63)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    outPPICtrl(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "PPI_CTRL");
        this.bPPICtrl = bOut;
    }

    /**
     * in8041Kbd(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x60)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in8041Kbd(port, addrFrom)
    {
        var b = this.kbd? this.kbd.readScanCode() : 0;
        this.printMessageIO(port, null, addrFrom, "8041_KBD", b);
        this.b8041Status &= ~ChipSet.KC8042.STATUS.OUTBUFF_FULL;
        return b;
    }

    /**
     * out8041Kbd(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x60)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    out8041Kbd(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "8041_KBD");
        // if (this.kbd) this.kbd.sendCmd(bOut);
    }

    /**
     * in8041Ctrl(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x61)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in8041Ctrl(port, addrFrom)
    {
        var b = this.bPPIB;
        this.printMessageIO(port, null, addrFrom, "8041_CTRL", b);
        return b;
    }

    /**
     * out8041Ctrl(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x61)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    out8041Ctrl(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "8041_CTRL");
        this.updatePPIB(bOut);
    }

    /**
     * in8041Status(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x64)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in8041Status(port, addrFrom)
    {
        var b = this.b8041Status;
        this.printMessageIO(port, null, addrFrom, "8041_STATUS", b);
        return b;
    }

    /**
     * in8042OutBuff(port, addrFrom)
     *
     * Return the contents of the OUTBUFF register and clear the OUTBUFF_FULL status bit.
     *
     * This function then calls kbd.checkScanCode(), on the theory that the next buffered scan
     * code, if any, can now be delivered to OUTBUFF.  However, there are applications like
     * BASICA that install a keyboard interrupt handler that reads OUTBUFF, do some scan code
     * preprocessing, and then pass control on to the ROM's interrupt handler.  As a result,
     * OUTBUFF is read multiple times during a single interrupt, so filling it with new data
     * after every read would result in lost scan codes.
     *
     * To avoid that problem, kbd.checkScanCode() also requires that kbd.setEnabled() be called
     * before it supplies any more data via notifyKbdData().  That will happen as soon as the
     * ROM re-enables the controller, and is why KC8042.CMD.ENABLE_KBD processing also ends with a
     * call to kbd.checkScanCode().
     *
     * Note that, the foregoing notwithstanding, I still clear the OUTBUFF_FULL bit here (as I
     * believe I should); fortunately, none of the interrupt handlers rely on OUTBUFF_FULL as a
     * prerequisite for reading OUTBUFF (not the BASICA handler, and not the ROM).  The assumption
     * seems to be that if an interrupt occurred, OUTBUFF must contain data, regardless of the
     * state of OUTBUFF_FULL.
     *
     * @this {ChipSet}
     * @param {number} port (0x60)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in8042OutBuff(port, addrFrom)
    {
        var b = this.b8042OutBuff;
        this.printMessageIO(port, null, addrFrom, "8042_OUTBUFF", b, Messages.C8042);
        this.b8042Status &= ~(ChipSet.KC8042.STATUS.OUTBUFF_FULL | ChipSet.KC8042.STATUS.OUTBUFF_DELAY);
        if (this.kbd) this.kbd.checkScanCode();
        return b;
    }

    /**
     * out8042InBuffData(port, bOut, addrFrom)
     *
     * This writes to the 8042's input buffer; using this port (ie, 0x60 instead of 0x64) designates the
     * the byte as a KC8042.DATA.CMD "data byte".  Before clearing KC8042.STATUS.CMD_FLAG, however, we see if it's set,
     * and then based on the previous KC8042.CMD "command byte", we do whatever needs to be done with this "data byte".
     *
     * @this {ChipSet}
     * @param {number} port (0x60)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    out8042InBuffData(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "8042_INBUF.DATA", null, Messages.C8042);

        if (this.b8042Status & ChipSet.KC8042.STATUS.CMD_FLAG) {

            switch (this.b8042InBuff) {

            case ChipSet.KC8042.CMD.WRITE_CMD:
                this.set8042CmdData(bOut);
                break;

            case ChipSet.KC8042.CMD.WRITE_OUTPORT:
                this.set8042OutPort(bOut);
                break;

            /*
             * This case is reserved for command bytes that the 8042 is not expecting, which should therefore be passed
             * on to the Keyboard itself.
             *
             * Here's some relevant MODEL_5170 ROM BIOS code, "XMIT_8042" (missing from the original MODEL_5170 ROM BIOS
             * listing), which sends a command code in AL to the Keyboard and waits for a response, returning it in AL.
             * Note that the only "success" exit path from this function involves LOOPing 64K times before finally reading
             * the Keyboard's response; either the hardware and/or this code seems a bit brain-damaged if that's REALLY
             * what you had to do to ensure a valid response....
             *
             *      F000:1B25 86E0          XCHG     AH,AL
             *      F000:1B27 2BC9          SUB      CX,CX
             *      F000:1B29 E464          IN       AL,64
             *      F000:1B2B A802          TEST     AL,02      ; WAIT FOR INBUFF_FULL TO BE CLEAR
             *      F000:1B2D E0FA          LOOPNZ   1B29
             *      F000:1B2F E334          JCXZ     1B65       ; EXIT WITH ERROR (CX == 0)
             *      F000:1B31 86E0          XCHG     AH,AL
             *      F000:1B33 E660          OUT      60,AL      ; SAFE TO WRITE KEYBOARD CMD TO INBUFF NOW
             *      F000:1B35 2BC9          SUB      CX,CX
             *      F000:1B37 E464          IN       AL,64
             *      F000:1B39 8AE0          MOV      AH,AL
             *      F000:1B3B A801          TEST     AL,01
             *      F000:1B3D 7402          JZ       1B41
             *      F000:1B3F E460          IN       AL,60      ; READ PORT 0x60 IF OUTBUFF_FULL SET ("FLUSH"?)
             *      F000:1B41 F6C402        TEST     AH,02
             *      F000:1B44 E0F1          LOOPNZ   1B37
             *      F000:1B46 751D          JNZ      1B65       ; EXIT WITH ERROR (CX == 0)
             *      F000:1B48 B306          MOV      BL,06
             *      F000:1B4A 2BC9          SUB      CX,CX
             *      F000:1B4C E464          IN       AL,64
             *      F000:1B4E A801          TEST     AL,01
             *      F000:1B50 E1FA          LOOPZ    1B4C
             *      F000:1B52 7508          JNZ      1B5C       ; PROCEED TO EXIT NOW THAT OUTBUFF_FULL IS SET
             *      F000:1B54 FECB          DEC      BL
             *      F000:1B56 75F4          JNZ      1B4C
             *      F000:1B58 FEC3          INC      BL
             *      F000:1B5A EB09          JMP      1B65       ; EXIT WITH ERROR (CX == 0)
             *      F000:1B5C 2BC9          SUB      CX,CX
             *      F000:1B5E E2FE          LOOP     1B5E       ; LOOOOOOPING....
             *      F000:1B60 E460          IN       AL,60
             *      F000:1B62 83E901        SUB      CX,0001    ; EXIT WITH SUCCESS (CX != 0)
             *      F000:1B65 C3            RET
             *
             * But WAIT, the FUN doesn't end there.  After this function returns, "KBD_RESET" waits for a Keyboard
             * interrupt to occur, hoping for scan code 0xAA as the Keyboard's final response.  "KBD_RESET" also returns
             * CX to the caller, and the caller ("TEST.21") assumes there was no interrupt if CX is zero.
             *
             *              MOV     AL,0FDH
             *              OUT     INTA01,AL
             *              MOV     INTR_FLAG,0
             *              STI
             *              MOV     BL,10
             *              SUB     CX,CX
             *      G11:    TEST    [1NTR_FLAG],02H
             *              JNZ     G12
             *              LOOP    G11
             *              DEC     BL
             *              JNZ     G11
             *              ...
             *
             * However, if [INTR_FLAG] is set immediately, the above code will exit immediately, without ever decrementing
             * CX.  CX can be zero not only if the loop exhausted it, but also if no looping was required; the latter is not
             * an error, but "TEST.21" assumes that it is.
             */
            default:
                this.set8042CmdData(this.b8042CmdData & ~ChipSet.KC8042.DATA.CMD.NO_CLOCK);
                if (this.kbd) this.set8042OutBuff(this.kbd.sendCmd(bOut));
                break;
            }
        }
        this.b8042InBuff = bOut;
        this.b8042Status &= ~ChipSet.KC8042.STATUS.CMD_FLAG;
    }

    /**
     * in8042RWReg(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x61)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in8042RWReg(port, addrFrom)
    {
        /*
         * Normally, we return whatever was last written to this port, but we do need to mask the
         * two upper-most bits (KC8042.RWREG.NMI_ERROR), as those are output-only bits used to signal
         * parity errors.
         *
         * Also, "TEST.09" of the MODEL_5170 BIOS expects the REFRESH_BIT to alternate, so we used to
         * do this:
         *
         *      this.bPPIB ^= ChipSet.KC8042.RWREG.REFRESH_BIT;
         *
         * However, the MODEL_5170_REV3 BIOS not only checks REFRESH_BIT in "TEST.09", but includes
         * an additional test right before "TEST.11A", which requires the bit change "a bit less"
         * frequently.  This new test sets CX to zero, and at the end of the test (@F000:05B8), CX
         * must be in the narrow range of 0xF600 through 0xF9FD.
         *
         * In fact, the new "WAITF" function @F000:1A3A tells us exactly how frequently REFRESH_BIT
         * is expected to change now.  That function performs a "FIXED TIME WAIT", where CX is a
         * "COUNT OF 15.085737us INTERVALS TO WAIT".
         *
         * So we now tie the state of the REFRESH_BIT to bit 6 of the current CPU cycle count,
         * effectively toggling the bit after every 64 cycles.  On an 8Mhz CPU that can do 8 cycles
         * in 1us, 64 cycles represents 8us, so that might be a bit fast for "WAITF", but bit 6
         * is the only choice that also satisfies the pre-"TEST.11A" test as well.
         */
        var b = this.bPPIB & ~(ChipSet.KC8042.RWREG.NMI_ERROR | ChipSet.KC8042.RWREG.REFRESH_BIT) | ((this.cpu.getCycles() & 0x40)? ChipSet.KC8042.RWREG.REFRESH_BIT : 0);
        /*
         * Thanks to the WAITF function, this has become a very "busy" port, so if this generates too
         * many messages, try adding Messages.LOG to the criteria.
         */
        this.printMessageIO(port, null, addrFrom, "8042_RWREG", b, Messages.C8042);
        return b;
    }

    /**
     * out8042RWReg(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x61)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     */
    out8042RWReg(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "8042_RWREG", null, Messages.C8042);
        this.updatePPIB(bOut);
    }

    /**
     * in8042Status(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x64)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in8042Status(port, addrFrom)
    {
        this.printMessageIO(port, null, addrFrom, "8042_STATUS", this.b8042Status, Messages.C8042);
        var b = this.b8042Status & 0xff;
        /*
         * There's code in the 5170 BIOS (F000:03BF) that writes an 8042 command (0xAA), waits for
         * KC8042.STATUS.INBUFF_FULL to go clear (which it always is, because we always accept commands
         * immediately), then checks KC8042.STATUS.OUTBUFF_FULL and performs a "flush" on port 0x60 if
         * it's set, then waits for KC8042.STATUS.OUTBUFF_FULL *again*.  Unfortunately, the "flush" throws
         * away our response if we respond immediately.
         *
         * So now when out8042InBuffCmd() has a response, it sets KC8042.STATUS.OUTBUFF_DELAY instead
         * (which is outside the 0xff range of bits we return); when we see KC8042.STATUS.OUTBUFF_DELAY,
         * we clear it and set KC8042.STATUS.OUTBUFF_FULL, which will be returned on the next read.
         *
         * This provides a single poll delay, so that the aforementioned "flush" won't toss our response.
         * If longer delays are needed down the road, we may need to set a delay count in the upper (hidden)
         * bits of b8042Status, instead of using a single delay bit.
         */
        if (this.b8042Status & ChipSet.KC8042.STATUS.OUTBUFF_DELAY) {
            this.b8042Status |= ChipSet.KC8042.STATUS.OUTBUFF_FULL;
            this.b8042Status &= ~ChipSet.KC8042.STATUS.OUTBUFF_DELAY;
        }
        return b;
    }

    /**
     * out8042InBuffCmd(port, bOut, addrFrom)
     *
     * This writes to the 8042's input buffer; using this port (ie, 0x64 instead of 0x60) designates the
     * the byte as a "command byte".  We immediately set KC8042.STATUS.CMD_FLAG, and then see if we can act upon
     * the command immediately (some commands requires us to wait for a "data byte").
     *
     * @this {ChipSet}
     * @param {number} port (0x64)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    out8042InBuffCmd(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "8042_INBUFF.CMD", null, Messages.C8042);
        this.assert(!(this.b8042Status & ChipSet.KC8042.STATUS.INBUFF_FULL));
        this.b8042InBuff = bOut;

        this.b8042Status |= ChipSet.KC8042.STATUS.CMD_FLAG;

        var bPulseBits = 0;
        if (this.b8042InBuff >= ChipSet.KC8042.CMD.PULSE_OUTPORT) {
            bPulseBits = (this.b8042InBuff ^ 0xf);
            /*
             * Now that we have isolated the bit(s) to pulse, map all pulse commands to KC8042.CMD.PULSE_OUTPORT
             */
            this.b8042InBuff = ChipSet.KC8042.CMD.PULSE_OUTPORT;
        }

        switch (this.b8042InBuff) {
        case ChipSet.KC8042.CMD.READ_CMD:           // 0x20
            this.set8042OutBuff(this.b8042CmdData);
            break;

        case ChipSet.KC8042.CMD.WRITE_CMD:          // 0x60
            /*
             * No further action required for this command; more data is expected via out8042InBuffData()
             */
            break;

        case ChipSet.KC8042.CMD.DISABLE_KBD:        // 0xAD
            this.set8042CmdData(this.b8042CmdData | ChipSet.KC8042.DATA.CMD.NO_CLOCK);
            if (DEBUG) this.printMessage("keyboard disabled", Messages.KEYBOARD | Messages.PORT);
            /*
             * NOTE: The MODEL_5170 BIOS calls "KBD_RESET" (F000:17D2) while the keyboard interface is disabled,
             * yet we must still deliver the Keyboard's CMDRES.BAT_OK response code?  Seems like an odd thing for
             * a "disabled interface" to do.
             */
            break;

        case ChipSet.KC8042.CMD.ENABLE_KBD:         // 0xAE
            this.set8042CmdData(this.b8042CmdData & ~ChipSet.KC8042.DATA.CMD.NO_CLOCK);
            if (DEBUG) this.printMessage("keyboard re-enabled", Messages.KEYBOARD | Messages.PORT);
            if (this.kbd) this.kbd.checkScanCode();
            break;

        case ChipSet.KC8042.CMD.SELF_TEST:          // 0xAA
            if (this.kbd) this.kbd.flushScanCode();
            this.set8042CmdData(this.b8042CmdData | ChipSet.KC8042.DATA.CMD.NO_CLOCK);
            if (DEBUG) this.printMessage("keyboard disabled on reset", Messages.KEYBOARD | Messages.PORT);
            this.set8042OutBuff(ChipSet.KC8042.DATA.SELF_TEST.OK);
            this.set8042OutPort(ChipSet.KC8042.OUTPORT.NO_RESET | ChipSet.KC8042.OUTPORT.A20_ON);
            break;

        case ChipSet.KC8042.CMD.INTF_TEST:          // 0xAB
            /*
             * TODO: Determine all the side-effects of the Interface Test, if any.
             */
            this.set8042OutBuff(ChipSet.KC8042.DATA.INTF_TEST.OK);
            break;

        case ChipSet.KC8042.CMD.READ_INPORT:        // 0xC0
            this.set8042OutBuff(this.b8042InPort);
            break;

        case ChipSet.KC8042.CMD.READ_OUTPORT:       // 0xD0
            this.set8042OutBuff(this.b8042OutPort);
            break;

        case ChipSet.KC8042.CMD.WRITE_OUTPORT:      // 0xD1
            /*
             * No further action required for this command; more data is expected via out8042InBuffData()
             */
            break;

        case ChipSet.KC8042.CMD.READ_TEST:          // 0xE0
            this.set8042OutBuff((this.b8042CmdData & ChipSet.KC8042.DATA.CMD.NO_CLOCK)? 0 : ChipSet.KC8042.TESTPORT.KBD_CLOCK);
            break;

        case ChipSet.KC8042.CMD.PULSE_OUTPORT:      // 0xF0-0xFF
            if (bPulseBits & 0x1) {
                /*
                 * Bit 0 of the 8042's output port is connected to RESET.  If it's pulsed, the processor resets.
                 * We don't want to clear *all* CPU state (eg, cycle counts), so we call cpu.resetRegs() instead
                 * of cpu.reset().
                 */
                this.cpu.resetRegs();
            }
            break;

        default:
            if (DEBUG && this.messageEnabled(Messages.C8042)) {
                this.printMessage("unrecognized 8042 command: " + Str.toHexByte(this.b8042InBuff), true);
                this.dbg.stopCPU();
            }
            break;
        }
    }

    /**
     * set8042CmdData(b)
     *
     * @this {ChipSet}
     * @param {number} b
     */
    set8042CmdData(b)
    {
        this.b8042CmdData = b;
        this.assert(ChipSet.KC8042.DATA.CMD.SYS_FLAG === ChipSet.KC8042.STATUS.SYS_FLAG);
        this.b8042Status = (this.b8042Status & ~ChipSet.KC8042.STATUS.SYS_FLAG) | (b & ChipSet.KC8042.DATA.CMD.SYS_FLAG);
        if (this.kbd) {
            /*
             * This seems to be what the doctor ordered for the MODEL_5170_REV3 BIOS @F000:0A6D, where it
             * sends ChipSet.KC8042.CMD.WRITE_CMD to port 0x64, followed by 0x4D to port 0x60, which clears NO_CLOCK
             * and enables the keyboard.  The BIOS then waits for OUTBUFF_FULL to be set, at which point it seems
             * to be anticipating an 0xAA response in the output buffer.
             *
             * And indeed, if we call the original MODEL_5150/MODEL_5160 setEnabled() Keyboard interface here,
             * and both the data and clock lines have transitioned high (ie, both parameters are true), then it
             * will call resetDevice(), generating a Keyboard.CMDRES.BAT_OK response.
             *
             * This agrees with my understanding of what happens when the 8042 toggles the clock line high
             * (ie, clears NO_CLOCK): the TechRef's "Basic Assurance Test" section says that when the Keyboard is
             * powered on, it performs the BAT, and then when the clock and data lines go high, the keyboard sends
             * a completion code (eg, 0xAA for success, or 0xFC or something else for failure).
             */
            this.kbd.setEnabled(!!(b & ChipSet.KC8042.DATA.CMD.NO_INHIBIT), !(b & ChipSet.KC8042.DATA.CMD.NO_CLOCK));
        }
    }

    /**
     * set8042OutBuff(b, fNoDelay)
     *
     * The 5170 ROM BIOS assumed there would be a slight delay after certain 8042 commands, like SELF_TEST
     * (0xAA), before there was an OUTBUFF response; in fact, there is BIOS code that will fail without such
     * a delay.  This is discussed in greater detail in in8042Status().
     *
     * So we default to a "single poll" delay, setting OUTBUFF_DELAY instead of OUTBUFF_FULL, unless the caller
     * explicitly asks for no delay.  The fNoDelay parameter was added later, so that notifyKbdData() could
     * request immediate delivery of keyboard scan codes, because some operating systems (eg, Microport's 1986
     * version of Unix for PC AT machines) poll the status port only once, immediately giving up if no data is
     * available.
     *
     * TODO: Determine if we should invert the fNoDelay default (from false to true) and delay only in specific
     * cases; ie, perhaps only the SELF_TEST command required a delay.
     *
     * @this {ChipSet}
     * @param {number} b
     * @param {boolean} [fNoDelay]
     */
    set8042OutBuff(b, fNoDelay)
    {
        if (b >= 0) {
            this.b8042OutBuff = b;
            if (fNoDelay) {
                this.b8042Status |= ChipSet.KC8042.STATUS.OUTBUFF_FULL;
            } else {
                this.b8042Status &= ~ChipSet.KC8042.STATUS.OUTBUFF_FULL;
                this.b8042Status |= ChipSet.KC8042.STATUS.OUTBUFF_DELAY;
            }
            if (DEBUG && this.messageEnabled(Messages.KEYBOARD | Messages.PORT)) {
                this.printMessage("set8042OutBuff(" + Str.toHexByte(b) + ',' + (fNoDelay? "no" : "") + "delay)", true);
            }
        }
    }

    /**
     * set8042OutPort(b)
     *
     * When ChipSet.KC8042.CMD.WRITE_OUTPORT (0xD1) is written to port 0x64, the next byte written to port 0x60 comes here,
     * to the KBC's OUTPORT.  One of the most important bits in the OUTPORT is the A20_ON bit (0x02): set it to turn A20 on,
     * clear it to turn A20 off.
     *
     * @this {ChipSet}
     * @param {number} b
     */
    set8042OutPort(b)
    {
        this.b8042OutPort = b;

        this.bus.setA20(!!(b & ChipSet.KC8042.OUTPORT.A20_ON));

        if (!(b & ChipSet.KC8042.OUTPORT.NO_RESET)) {
            /*
             * Bit 0 of the 8042's output port is connected to RESET.  Normally, it's "pulsed" with the
             * KC8042.CMD.PULSE_OUTPORT command, so if a RESET is detected via this command, we should try to
             * determine if that's what the caller intended.
             */
            if (DEBUG && this.messageEnabled(Messages.C8042)) {
                this.printMessage("unexpected 8042 output port reset: " + Str.toHexByte(b), true);
                this.dbg.stopCPU();
            }
            this.cpu.resetRegs();
        }
    }

    /**
     * notifyKbdData(b)
     *
     * In the old days of PCx86, the Keyboard component would simply call setIRR() when it had some data for the
     * keyboard controller.  However, the Keyboard's sole responsibility is to emulate an actual keyboard and call
     * notifyKbdData() whenever it has some data; it's not allowed to mess with IRQ lines.
     *
     * If there's an 8042, we check (this.b8042CmdData & ChipSet.KC8042.DATA.CMD.NO_CLOCK); if NO_CLOCK is clear,
     * we can raise the IRQ immediately.  Well, not quite immediately....
     *
     * Notes regarding the MODEL_5170 (eg, /devices/pc/machine/5170/ega/1152kb/rev3/machine.xml):
     *
     * The "Rev3" BIOS, dated 11-Nov-1985, contains the following code in the keyboard interrupt handler at K26A:
     *
     *      F000:3704 FA            CLI
     *      F000:3705 B020          MOV      AL,20
     *      F000:3707 E620          OUT      20,AL
     *      F000:3709 B0AE          MOV      AL,AE
     *      F000:370B E88D02        CALL     SHIP_IT
     *      F000:370E FA            CLI                     <-- window of opportunity
     *      F000:370F 07            POP      ES
     *      F000:3710 1F            POP      DS
     *      F000:3711 5F            POP      DI
     *      F000:3712 5E            POP      SI
     *      F000:3713 5A            POP      DX
     *      F000:3714 59            POP      CX
     *      F000:3715 5B            POP      BX
     *      F000:3716 58            POP      AX
     *      F000:3717 5D            POP      BP
     *      F000:3718 CF            IRET
     *
     * and SHIP_IT looks like this:
     *
     *      F000:399B 50            PUSH     AX
     *      F000:399C FA            CLI
     *      F000:399D 2BC9          SUB      CX,CX
     *      F000:399F E464          IN       AL,64
     *      F000:39A1 A802          TEST     AL,02
     *      F000:39A3 E0FA          LOOPNZ   399F
     *      F000:39A5 58            POP      AX
     *      F000:39A6 E664          OUT      64,AL
     *      F000:39A8 FB            STI
     *      F000:39A9 C3            RET
     *
     * This code *appears* to be trying to ensure that another keyboard interrupt won't occur until after the IRET,
     * but sadly, it looks to me like the CLI following the call to SHIP_IT is too late.  SHIP_IT should have been
     * written with PUSHF/CLI and POPF intro/outro sequences, thereby honoring the first CLI at the top of K26A and
     * eliminating the need for the second CLI (@F000:370E).
     *
     * Of course, in "real life", this was probably never a problem, because the 8042 probably wasn't fast enough to
     * generate another interrupt so soon after receiving the ChipSet.KC8042.CMD.ENABLE_KBD command.  In my case, I ran
     * into this problem by 1) turning on "kbd" Debugger messages and 2) rapidly typing lots of keys.  The Debugger
     * messages bogged the machine down enough for me to hit the "window of opportunity", generating this message in
     * PC-DOS 3.20:
     *
     *      "FATAL: Internal Stack Failure, System Halted."
     *
     * and halting the system @0070:0923 (JMP 0923).
     *
     * That wasn't the only spot in the BIOS where I hit this problem; here's another "window of opportunity":
     *
     *      F000:3975 FA            CLI
     *      F000:3976 B020          MOV      AL,20
     *      F000:3978 E620          OUT      20,AL
     *      F000:397A B0AE          MOV      AL,AE
     *      F000:397C E81C00        CALL     SHIP_IT
     *      F000:397F B80291        MOV      AX,9102        <-- window of opportunity
     *      F000:3982 CD15          INT      15
     *      F000:3984 80269600FC    AND      [0096],FC
     *      F000:3989 E982FD        JMP      370E
     *
     * In this second, lengthier, example, I counted about 60 instructions being executed from the EOI @F000:3978 to
     * the final IRET @F000:3718, most of them in the INT 0x15 handler.  So, I'm going to double that count to 120
     * instructions, just to be safe, and pass that along to every setIRR() call we make here.
     *
     * @this {ChipSet}
     * @param {number} b
     */
    notifyKbdData(b)
    {
        if (DEBUG && this.messageEnabled(Messages.KEYBOARD | Messages.PORT)) {
            this.printMessage("notifyKbdData(" + Str.toHexByte(b) + ')', true);
        }
        if (this.model < ChipSet.MODEL_5170) {
            /*
             * TODO: Should we be checking bPPI for PPI_B.CLK_KBD on these older machines, before calling setIRR()?
             */
            this.setIRR(ChipSet.IRQ.KBD, 4);
            this.b8041Status |= ChipSet.KC8042.STATUS.OUTBUFF_FULL;
        }
        else {
            if (!(this.b8042CmdData & ChipSet.KC8042.DATA.CMD.NO_CLOCK)) {
                /*
                 * The next read of b8042OutBuff will clear both of these bits and call kbd.checkScanCode(),
                 * which will call notifyKbdData() again if there's still keyboard data to process.
                 */
                if (!(this.b8042Status & (ChipSet.KC8042.STATUS.OUTBUFF_FULL | ChipSet.KC8042.STATUS.OUTBUFF_DELAY))) {
                    this.set8042OutBuff(b, true);
                    this.kbd.shiftScanCode();
                    /*
                     * A delay of 4 instructions was originally requested as part of the the Keyboard's resetDevice()
                     * response, but a larger delay (120) is now needed for MODEL_5170 machines, per the discussion above.
                     */
                    this.setIRR(ChipSet.IRQ.KBD, 120);
                }
                else {
                    if (DEBUG && this.messageEnabled(Messages.KEYBOARD | Messages.PORT)) {
                        this.printMessage("notifyKbdData(" + Str.toHexByte(b) + "): output buffer full", true);
                    }
                }
            } else {
                if (DEBUG && this.messageEnabled(Messages.KEYBOARD | Messages.PORT)) {
                    this.printMessage("notifyKbdData(" + Str.toHexByte(b) + "): disabled", true);
                }
            }
        }
    }

    /**
     * in6300DIPSwitches(iDIP, port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} iDIP (0 or 1)
     * @param {number} port (0x66 or 0x67)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    in6300DIPSwitches(iDIP, port, addrFrom)
    {
        var b = this.aDIPSwitches[iDIP][1];
        this.printMessageIO(port, null, addrFrom, "DIPSW-" + iDIP, b, Messages.CHIPSET);
        return b;
    }

    /**
     * inCMOSAddr(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x70)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inCMOSAddr(port, addrFrom)
    {
        this.printMessageIO(port, null, addrFrom, "CMOS.ADDR", this.bCMOSAddr, Messages.CMOS);
        return this.bCMOSAddr;
    }

    /**
     * outCMOSAddr(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x70)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    outCMOSAddr(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "CMOS.ADDR", null, Messages.CMOS);
        this.bCMOSAddr = bOut;
        this.bNMI = (bOut & ChipSet.CMOS.ADDR.NMI_DISABLE)? ChipSet.NMI.DISABLE : ChipSet.NMI.ENABLE;
    }

    /**
     * inCMOSData(port, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x71)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to read the specified port)
     * @return {number} simulated port value
     */
    inCMOSData(port, addrFrom)
    {
        var bAddr = this.bCMOSAddr & ChipSet.CMOS.ADDR.MASK;
        var bIn = (bAddr <= ChipSet.CMOS.ADDR.STATUSD? this.getRTCByte(bAddr) : this.abCMOSData[bAddr]);
        if (this.messageEnabled(Messages.CMOS | Messages.PORT)) {
            this.printMessageIO(port, null, addrFrom, "CMOS.DATA[" + Str.toHexByte(bAddr) + "]", bIn, true);
        }
        if (addrFrom != null) {
            if (bAddr == ChipSet.CMOS.ADDR.STATUSC) {
                /*
                 * When software reads the STATUSC port, all interrupt bits (PF, AF, and UF) are automatically
                 * cleared, which in turn clears the IRQF bit, which in turn clears the IRQ.
                 */
                this.abCMOSData[bAddr] &= ChipSet.CMOS.STATUSC.RESERVED;
                if (bIn & ChipSet.CMOS.STATUSC.IRQF) this.clearIRR(ChipSet.IRQ.RTC);
                /*
                 * If we just cleared PF, and PIE is still set, then we need to make sure the next Periodic Interrupt
                 * occurs in a timely manner, too.
                 */
                if ((bIn & ChipSet.CMOS.STATUSC.PF) && (this.abCMOSData[ChipSet.CMOS.ADDR.STATUSB] & ChipSet.CMOS.STATUSB.PIE)) {
                    if (DEBUG) this.printMessage("RTC periodic interrupt cleared", Messages.RTC);
                    this.setRTCCycleLimit();
                }
            }
        }
        return bIn;
    }

    /**
     * outCMOSData(port, bOut, addrFrom)
     *
     * @this {ChipSet}
     * @param {number} port (0x71)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    outCMOSData(port, bOut, addrFrom)
    {
        var bAddr = this.bCMOSAddr & ChipSet.CMOS.ADDR.MASK;
        if (this.messageEnabled(Messages.CMOS | Messages.PORT)) {
            this.printMessageIO(port, bOut, addrFrom, "CMOS.DATA[" + Str.toHexByte(bAddr) + "]", null, true);
        }
        var bDelta = bOut ^ this.abCMOSData[bAddr];
        this.abCMOSData[bAddr] = (bAddr <= ChipSet.CMOS.ADDR.STATUSD? this.setRTCByte(bAddr, bOut) : bOut);
        if (bAddr == ChipSet.CMOS.ADDR.STATUSB && (bDelta & ChipSet.CMOS.STATUSB.PIE)) {
            if (bOut & ChipSet.CMOS.STATUSB.PIE) {
                if (DEBUG) this.printMessage("RTC periodic interrupts enabled", Messages.RTC);
                this.setRTCCycleLimit();
            } else {
                if (DEBUG) this.printMessage("RTC periodic interrupts disabled", Messages.RTC);
            }
        }
    }

    /**
     * outNMI(port, bOut, addrFrom)
     *
     * This handler is installed only for models before MODEL_5170.
     *
     * @this {ChipSet}
     * @param {number} port (0xA0)
     * @param {number} bOut
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    outNMI(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "NMI");
        this.bNMI = bOut;
    }

    /**
     * outFPUClear(port, bOut, addrFrom)
     *
     * This handler is installed only for MODEL_5170.
     *
     * @this {ChipSet}
     * @param {number} port (0xF0)
     * @param {number} bOut (0x00 is the only expected output)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    outFPUClear(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "FPU.CLEAR");
        this.assert(!bOut);
        if (this.fpu) this.fpu.clearBusy();
    }

    /**
     * outFPUReset(port, bOut, addrFrom)
     *
     * This handler is installed only for MODEL_5170.
     *
     * @this {ChipSet}
     * @param {number} port (0xF1)
     * @param {number} bOut (0x00 is the only expected output)
     * @param {number} [addrFrom] (not defined if the Debugger is trying to write the specified port)
     */
    outFPUReset(port, bOut, addrFrom)
    {
        this.printMessageIO(port, bOut, addrFrom, "FPU.RESET");
        this.assert(!bOut);
        if (this.fpu) this.fpu.resetFPU();
    }

    /**
     * intBIOSRTC(addr)
     *
     * INT 0x1A Quick Reference:
     *
     *      AH
     *      ----
     *      0x00    Get current clock count in CX:DX
     *      0x01    Set current clock count from CX:DX
     *      0x02    Get real-time clock using BCD (CH=hours, CL=minutes, DH=seconds)
     *      0x03    Set real-time clock using BCD (CH=hours, CL=minutes, DH=seconds, DL=1 if Daylight Savings Time option)
     *      0x04    Get real-time date using BCD (CH=century, CL=year, DH=month, DL=day)
     *      0x05    Set real-time date using BCD (CH=century, CL=year, DH=month, DL=day)
     *      0x06    Set alarm using BCD (CH=hours, CL=minutes, DH=seconds)
     *      0x07    Reset alarm
     *
     * @this {ChipSet}
     * @param {number} addr
     * @return {boolean} true to proceed with the INT 0x1A software interrupt, false to skip
     */
    intBIOSRTC(addr)
    {
        if (DEBUGGER) {
            if (this.messageEnabled(Messages.INT) && this.dbg.messageInt(Interrupts.RTC, addr)) {
                /*
                 * By computing AH now, we get the incoming AH value; if we computed it below, along with
                 * the rest of the register values, we'd get the outgoing AH value, which is not what we want.
                 */
                var AH = this.cpu.regEAX >> 8;
                this.cpu.addIntReturn(addr, function(chipset, nCycles) {
                    return function onBIOSRTCReturn(nLevel) {
                        nCycles = chipset.cpu.getCycles() - nCycles;
                        var sResult;
                        var CL = chipset.cpu.regEDX & 0xff;
                        var CH = chipset.cpu.regEDX >> 8;
                        var DL = chipset.cpu.regEDX & 0xff;
                        var DH = chipset.cpu.regEDX >> 8;
                        if (AH == 0x02 || AH == 0x03) {
                            sResult = " CH(hour)=" + Str.toHexWord(CH) + " CL(min)=" + Str.toHexByte(CL) + " DH(sec)=" + Str.toHexByte(DH);
                        } else if (AH == 0x04 || AH == 0x05) {
                            sResult = " CX(year)=" + Str.toHexWord(chipset.cpu.regECX) + " DH(month)=" + Str.toHexByte(DH) + " DL(day)=" + Str.toHexByte(DL);
                        }
                        chipset.dbg.messageIntReturn(Interrupts.RTC, nLevel, nCycles, sResult);
                    };
                }(this, this.cpu.getCycles()));
            }
        }
        return true;
    }

    /**
     * setSpeaker(fOn)
     *
     * @this {ChipSet}
     * @param {boolean} [fOn] true to turn speaker on, false to turn off, otherwise update as appropriate
     */
    setSpeaker(fOn)
    {
        if (this.contextAudio) {
            try {
                if (fOn !== undefined) {
                    this.fSpeaker = fOn;
                } else {
                    fOn = !!(this.fSpeaker && this.cpu && this.cpu.isRunning());
                }
                var freq = Math.round(ChipSet.TIMER_TICKS_PER_SEC / this.getTimerInit(ChipSet.PIT0.TIMER2));
                /*
                 * Treat frequencies outside the normal hearing range (below 20hz or above 20Khz) as a clever attempt
                 * to turn sound off; we have to explicitly turn the sound off in those cases, to prevent the Audio API
                 * from "easing" the audio to the target frequency and creating odd sound effects.
                 */
                if (freq < 20 || freq > 20000) fOn = false;
                if (fOn) {
                    if (!this.oscillatorAudio) {
                        this.oscillatorAudio = this.contextAudio['createOscillator']();
                        this.gainAudio = this.contextAudio['createGain']();
                        this.oscillatorAudio['connect'](this.gainAudio);
                        this.gainAudio['connect'](this.contextAudio['destination']);
                        this.oscillatorAudio['frequency']['value'] = freq;
                        this.oscillatorAudio['type'] = "square";
                        this.oscillatorAudio['start'](0);
                    }
                    this.oscillatorAudio['frequency']['value'] = freq;
                    this.gainAudio['gain']['value'] = 1;
                    if (this.messageEnabled(Messages.SPEAKER)) this.printMessage("speaker on at  " + freq + "hz", true);
                } else if (this.oscillatorAudio) {
                    this.gainAudio['gain']['value'] = 0;
                    if (this.messageEnabled(Messages.SPEAKER)) this.printMessage("speaker off at " + freq + "hz", true);
                }
            } catch(e) {
                this.notice("AudioContext exception: " + e.message);
                this.contextAudio = null;
            }
        } else if (fOn) {
            this.printMessage("BEEP", Messages.SPEAKER);
        }
    }

    /**
     * messageBitsDMA(iChannel)
     *
     * @this {ChipSet}
     * @param {number} [iChannel] if the message is associated with a particular IRQ #
     * @return {number}
     */
    messageBitsDMA(iChannel)
    {
        var bitsMessage = 0;
        if (DEBUG) {
            bitsMessage = Messages.DATA;
            if (iChannel == ChipSet.DMA_FDC) {
                bitsMessage |= Messages.FDC;
            } else if (iChannel == ChipSet.DMA_HDC) {
                bitsMessage |= Messages.HDC;
            }
        }
        return bitsMessage;
    }

    /**
     * messageBitsIRQ(nIRQ)
     *
     * @this {ChipSet}
     * @param {number|undefined} [nIRQ] if the message is associated with a particular IRQ #
     * @return {number}
     */
    messageBitsIRQ(nIRQ)
    {
        var bitsMessage = 0;
        if (DEBUG) {
            bitsMessage = Messages.PIC;
            if (nIRQ == ChipSet.IRQ.TIMER0) {           // IRQ 0
                bitsMessage |= Messages.TIMER;
            } else if (nIRQ == ChipSet.IRQ.KBD) {       // IRQ 1
                bitsMessage |= Messages.KEYBOARD;
            } else if (nIRQ == ChipSet.IRQ.SLAVE) {     // IRQ 2 (MODEL_5170 and up)
                bitsMessage |= Messages.CHIPSET;
            } else if (nIRQ == ChipSet.IRQ.COM1 || nIRQ == ChipSet.IRQ.COM2) {
                bitsMessage |= Messages.SERIAL;
            } else if (nIRQ == ChipSet.IRQ.XTC) {       // IRQ 5 (MODEL_5160)
                bitsMessage |= Messages.HDC;
            } else if (nIRQ == ChipSet.IRQ.FDC) {       // IRQ 6
                bitsMessage |= Messages.FDC;
            } else if (nIRQ == ChipSet.IRQ.RTC) {       // IRQ 8 (MODEL_5170 and up)
                bitsMessage |= Messages.RTC;
            } else if (nIRQ == ChipSet.IRQ.ATC) {       // IRQ 14 (MODEL_5170 and up)
                bitsMessage |= Messages.HDC;
            }
        }
        return bitsMessage;
    }

    /**
     * checkDMA()
     *
     * Called by the CPU whenever INTR.DMA is set.
     *
     * @return {boolean} true if one or more async DMA channels are still active (unmasked), false to reset INTR.DMA
     *
     checkDMA()
     {
         var fActive = false;
         for (var iDMAC = 0; iDMAC < this.aDMACs; iDMAC++) {
             var controller = this.aDMACs[iDMAC];
             for (var iChannel = 0; iChannel < controller.aChannels.length; iChannel++) {
                 var channel = controller.aChannels[iChannel];
                 if (!channel.masked) {
                     this.advanceDMA(channel);
                     if (!channel.masked) fActive = true;
                 }
             }
         }
         return fActive;
     }
     */

    /**
     * ChipSet.init()
     *
     * This function operates on every HTML element of class "chipset", extracting the
     * JSON-encoded parameters for the ChipSet constructor from the element's "data-value"
     * attribute, invoking the constructor to create a ChipSet component, and then binding
     * any associated HTML controls to the new component.
     */
    static init()
    {
        var aeChipSet = Component.getElementsByClass(document, PCX86.APPCLASS, "chipset");
        for (var iChip = 0; iChip < aeChipSet.length; iChip++) {
            var eChipSet = aeChipSet[iChip];
            var parmsChipSet = Component.getComponentParms(eChipSet);
            var chipset = new ChipSet(parmsChipSet);
            Component.bindComponentControls(chipset, eChipSet, PCX86.APPCLASS);
            chipset.updateDIPSwitchDescriptions();
        }
    }
}

/*
 * Ports Overview
 * --------------
 *
 * This module provides support for many of the following components (except where a separate component is noted).
 * This list is taken from p.1-8 ("System Unit") of the IBM 5160 (PC XT) Technical Reference Manual (as revised
 * April 1983), only because I didn't see a similar listing in the original 5150 Technical Reference.
 *
 *      Port(s)         Description
 *      -------         -----------
 *      000-00F         DMA Chip 8237A-5                                [see below]
 *      020-021         Interrupt 8259A                                 [see below]
 *      040-043         Timer 8253-5                                    [see below]
 *      060-063         PPI 8255A-5                                     [see below]
 *      080-083         DMA Page Registers                              [see below]
 *          0Ax [1]     NMI Mask Register                               [see below]
 *          0Cx         Reserved
 *          0Ex         Reserved
 *      200-20F         Game Control
 *      210-217         Expansion Unit
 *      220-24F         Reserved
 *      278-27F         Reserved
 *      2F0-2F7         Reserved
 *      2F8-2FF         Asynchronous Communications (Secondary)         [see the SerialPort component]
 *      300-31F         Prototype Card
 *      320-32F         Hard Drive Controller (XTC)                     [see the HDC component]
 *      378-37F         Printer
 *      380-38C [2]     SDLC Communications
 *      380-389 [2]     Binary Synchronous Communications (Secondary)
 *      3A0-3A9         Binary Synchronous Communications (Primary)
 *      3B0-3BF         IBM Monochrome Display/Printer                  [see the Video component]
 *      3C0-3CF         Reserved
 *      3D0-3DF         Color/Graphics (Motorola 6845)                  [see the Video component]
 *      3EO-3E7         Reserved
 *      3FO-3F7         Floppy Drive Controller                         [see the FDC component]
 *      3F8-3FF         Asynchronous Communications (Primary)           [see the SerialPort component]
 *
 * [1] At power-on time, NMI is masked off, perhaps because models 5150 and 5160 also tie coprocessor
 * (FPU) interrupts to NMI.  Suppressing NMI by default seems odd, because that would also suppress memory
 * parity errors.  TODO: Determine whether "power-on time" refers to the initial power-on state of the
 * NMI Mask Register or the state that the BIOS "POST" (Power-On Self-Test) sets.
 *
 * [2] These devices cannot be used together since their port addresses overlap.
 *
 *      MODEL_5170      Description
 *      ----------      -----------
 *          070 [3]     CMOS Address                                    ChipSet.CMOS.ADDR.PORT
 *          071         CMOS Data                                       ChipSet.CMOS.DATA.PORT
 *          0F0         FPU Coprocessor Clear Busy (output 0x00)
 *          0F1         FPU Coprocessor Reset (output 0x00)
 *      1F0-1F7         Hard Drive Controller (ATC)                     [see the HDC component]
 *
 * [3] Port 0x70 doubles as the NMI Mask Register: output a CMOS address with bit 7 clear to enable NMI
 * or with bit 7 set to disable NMI (apparently the inverse of the older NMI Mask Register at port 0xA0).
 * Also, apparently unlike previous models, the MODEL_5170 POST leaves NMI enabled.  And fortunately, the
 * FPU coprocessor interrupt line is no longer tied to NMI (it uses IRQ 13).
 */

/*
 * Supported model numbers
 *
 * In general, when comparing this.model to "base" model numbers (ie, non-REV numbers), you should use
 * (this.model|0), which truncates the current model number.
 *
 * Note that there were two 5150 motherboard revisions: the "REV A" 16Kb-64Kb motherboard and the
 * "REV B" 64Kb-256Kb motherboard.  There may have been a manufacturing correlation between motherboard
 * revisions ("REV A" and "REV B") and the ROM BIOS revisions shown below, but in general, we can't assume
 * any correlation, because newer ROMs could be installed with either motherboard.
 *
 * I do know that, for "REV A" motherboards, the Apr 1984 5150 TechRef says that "To expand the memory
 * of your system beyond 544K requires your IBM Personal Computer System Unit to have a BIOS ROM module
 * dated 10/27/82 or later."  Which suggests that SW2[5] was not used until the REV3 5150 ROM BIOS.
 *
 * For now, we treat all our MODEL_5150 systems as 16Kb-64Kb motherboards; if you want a 64Kb-256Kb motherboard,
 * then step up to a MODEL_5160 system.  We use a multiplier of 16 for 5150 LOWMEM values, and a multiplier
 * of 64 for 5160 LOWMEM values.
 */
ChipSet.MODEL_5150              = 5150;     // used in reference to the 1st 5150 ROM BIOS, dated Apr 24, 1981
ChipSet.MODEL_5150_REV2         = 5150.2;   // used in reference to the 2nd 5150 ROM BIOS, dated Oct 19, 1981
ChipSet.MODEL_5150_REV3         = 5150.3;   // used in reference to the 3rd 5150 ROM BIOS, dated Oct 27, 1982
ChipSet.MODEL_5150_OTHER        = 5150.9;

ChipSet.MODEL_5160              = 5160;     // used in reference to the 1st 5160 ROM BIOS, dated Nov 08, 1982
ChipSet.MODEL_5160_REV2         = 5160.2;   // used in reference to the 1st 5160 ROM BIOS, dated Jan 10, 1986
ChipSet.MODEL_5160_REV3         = 5160.3;   // used in reference to the 1st 5160 ROM BIOS, dated May 09, 1986
ChipSet.MODEL_5160_OTHER        = 5160.9;

ChipSet.MODEL_5170              = 5170;     // used in reference to the 1st 5170 ROM BIOS, dated Jan 10, 1984
ChipSet.MODEL_5170_REV2         = 5170.2;   // used in reference to the 2nd 5170 ROM BIOS, dated Jun 10, 1985
ChipSet.MODEL_5170_REV3         = 5170.3;   // used in reference to the 3rd 5170 ROM BIOS, dated Nov 15, 1985
ChipSet.MODEL_5170_OTHER        = 5170.9;

/*
 * Assorted non-IBM models (we don't put "IBM" in the IBM models, but non-IBM models should include the company name).
 */
ChipSet.MODEL_CDP_MPC1600       = 5150.101; // Columbia Data Products MPC 1600 ("Copyright Columbia Data Products 1983, ROM/BIOS Ver 4.34")
ChipSet.MODEL_COMPAQ_PORTABLE   = 5150.102; // COMPAQ Portable (COMPAQ's first PC)

ChipSet.MODEL_ATT_6300          = 5160.101; // AT&T Personal Computer 6300/Olivetti M24 ("COPYRIGHT (C) OLIVETTI 1984","04/03/86",v1.43)
ChipSet.MODEL_ZENITH_Z150       = 5160.150; // Zenith Data Systems Z-150 ("08/11/88 (C)ZDS CORP")

ChipSet.MODEL_COMPAQ_DESKPRO386 = 5180;     // COMPAQ DeskPro 386 (COMPAQ's first 80386-based PC); should be > MODEL_5170

/*
 * Last but not least, a complete list of supported model strings, and corresponding internal model numbers.
 */
ChipSet.MODELS = {
    "5150":         ChipSet.MODEL_5150,
    "5160":         ChipSet.MODEL_5160,
    "5170":         ChipSet.MODEL_5170,
    "att6300":      ChipSet.MODEL_ATT_6300,
    "mpc1600":      ChipSet.MODEL_CDP_MPC1600,
    "z150":         ChipSet.MODEL_ZENITH_Z150,
    "compaq":       ChipSet.MODEL_COMPAQ_PORTABLE,
    "other":        ChipSet.MODEL_5150_OTHER
};

if (DESKPRO386) {
    ChipSet.MODELS["deskpro386"] = ChipSet.MODEL_COMPAQ_DESKPRO386;
}

ChipSet.CONTROLS = {
    SW1:    "sw1",
    SW2:    "sw2",
    SWDESC: "swdesc"
};

/*
 * Values returned by ChipSet.getDIPVideoMonitor()
 */
ChipSet.MONITOR = {
    NONE:               0,
    TV:                 1,  // Composite monitor (lower resolution; no support)
    COLOR:              2,  // Color Display (5153)
    MONO:               3,  // Monochrome Display (5151)
    EGACOLOR:           4,  // Enhanced Color Display (5154) in High-Res Mode
    EGAEMULATION:       6,  // Enhanced Color Display (5154) in Emulation Mode
    VGACOLOR:           7   // VGA Color Display
};

/*
 *  8237A DMA Controller (DMAC) I/O ports
 *
 *  MODEL_5150 and up uses DMA channel 0 for memory refresh cycles and channel 2 for the FDC.
 *
 *  MODEL_5160 and up uses DMA channel 3 for HDC transfers (XTC only).
 *
 *  DMA0 refers to the original DMA controller found on all models, and DMA1 refers to the additional
 *  controller found on MODEL_5170 and up; channel 4 on DMA1 is used to "cascade" channels 0-3 from DMA0,
 *  so only channels 5-7 are available on DMA1.
 *
 *  For FDC DMA notes, refer to http://wiki.osdev.org/ISA_DMA
 *  For general DMA notes, refer to http://www.freebsd.org/doc/en/books/developers-handbook/dma.html
 *
 *  TODO: Determine why the MODEL_5150 ROM BIOS sets the DMA channel 1 page register (port 0x83) to zero.
 */
ChipSet.DMA0 = {
    INDEX:              0,
    PORT: {
        CH0_ADDR:       0x00,   // OUT: starting address        IN: current address
        CH0_COUNT:      0x01,   // OUT: starting word count     IN: remaining word count
        CH1_ADDR:       0x02,   // OUT: starting address        IN: current address
        CH1_COUNT:      0x03,   // OUT: starting word count     IN: remaining word count
        CH2_ADDR:       0x04,   // OUT: starting address        IN: current address
        CH2_COUNT:      0x05,   // OUT: starting word count     IN: remaining word count
        CH3_ADDR:       0x06,   // OUT: starting address        IN: current address
        CH3_COUNT:      0x07,   // OUT: starting word count     IN: remaining word count
        CMD_STATUS:     0x08,   // OUT: command register        IN: status register
        REQUEST:        0x09,
        MASK:           0x0A,
        MODE:           0x0B,
        RESET_FF:       0x0C,   // reset flip-flop
        MASTER_CLEAR:   0x0D,   // OUT: master clear            IN: temporary register
        MASK_CLEAR:     0x0E,   // TODO: Provide handlers
        MASK_ALL:       0x0F,   // TODO: Provide handlers
        CH2_PAGE:       0x81,   // OUT: DMA channel 2 page register
        CH3_PAGE:       0x82,   // OUT: DMA channel 3 page register
        CH1_PAGE:       0x83,   // OUT: DMA channel 1 page register
        CH0_PAGE:       0x87    // OUT: DMA channel 0 page register (unusable; See "The Inside Out" book, p.246)
    }
};
ChipSet.DMA1 = {
    INDEX:              1,
    PORT: {
        CH6_PAGE:       0x89,   // OUT: DMA channel 6 page register (MODEL_5170)
        CH7_PAGE:       0x8A,   // OUT: DMA channel 7 page register (MODEL_5170)
        CH5_PAGE:       0x8B,   // OUT: DMA channel 5 page register (MODEL_5170)
        CH4_PAGE:       0x8F,   // OUT: DMA channel 4 page register (MODEL_5170; unusable; aka "Refresh" page register?)
        CH4_ADDR:       0xC0,   // OUT: starting address        IN: current address
        CH4_COUNT:      0xC2,   // OUT: starting word count     IN: remaining word count
        CH5_ADDR:       0xC4,   // OUT: starting address        IN: current address
        CH5_COUNT:      0xC6,   // OUT: starting word count     IN: remaining word count
        CH6_ADDR:       0xC8,   // OUT: starting address        IN: current address
        CH6_COUNT:      0xCA,   // OUT: starting word count     IN: remaining word count
        CH7_ADDR:       0xCC,   // OUT: starting address        IN: current address
        CH7_COUNT:      0xCE,   // OUT: starting word count     IN: remaining word count
        CMD_STATUS:     0xD0,   // OUT: command register        IN: status register
        REQUEST:        0xD2,
        MASK:           0xD4,
        MODE:           0xD6,
        RESET_FF:       0xD8,   // reset flip-flop
        MASTER_CLEAR:   0xDA,   // master clear
        MASK_CLEAR:     0xDC,   // TODO: Provide handlers
        MASK_ALL:       0xDE    // TODO: Provide handlers
    }
};

ChipSet.DMA_CMD = {
    M2M_ENABLE:         0x01,
    CH0HOLD_ENABLE:     0x02,
    CTRL_DISABLE:       0x04,
    COMP_TIMING:        0x08,
    ROT_PRIORITY:       0x10,
    EXT_WRITE_SEL:      0x20,
    DREQ_ACTIVE_LO:     0x40,
    DACK_ACTIVE_HI:     0x80
};

ChipSet.DMA_STATUS = {
    CH0_TC:             0x01,   // Channel 0 has reached Terminal Count (TC)
    CH1_TC:             0x02,   // Channel 1 has reached Terminal Count (TC)
    CH2_TC:             0x04,   // Channel 2 has reached Terminal Count (TC)
    CH3_TC:             0x08,   // Channel 3 has reached Terminal Count (TC)
    ALL_TC:             0x0f,   // all TC bits are cleared whenever DMA_STATUS is read
    CH0_REQ:            0x10,   // Channel 0 DMA requested
    CH1_REQ:            0x20,   // Channel 1 DMA requested
    CH2_REQ:            0x40,   // Channel 2 DMA requested
    CH3_REQ:            0x80    // Channel 3 DMA requested
};

ChipSet.DMA_MASK = {
    CHANNEL:            0x03,
    CHANNEL_SET:        0x04
};

ChipSet.DMA_MODE = {
    CHANNEL:            0x03,   // bits 0-1 select 1 of 4 possible channels
    TYPE:               0x0C,   // bits 2-3 select 1 of 3 valid (4 possible) transfer types
    TYPE_VERIFY:        0x00,   // pseudo transfer (generates addresses, responds to EOP, but nothing is moved)
    TYPE_WRITE:         0x04,   // write to memory (move data FROM an I/O device; eg, reading a sector from a disk)
    TYPE_READ:          0x08,   // read from memory (move data TO an I/O device; eg, writing a sector to a disk)
    AUTOINIT:           0x10,
    DECREMENT:          0x20,   // clear for INCREMENT
    MODE:               0xC0,   // bits 6-7 select 1 of 4 possible transfer modes
    MODE_DEMAND:        0x00,
    MODE_SINGLE:        0x40,
    MODE_BLOCK:         0x80,
    MODE_CASCADE:       0xC0
};

ChipSet.DMA_REFRESH   = 0x00;   // DMA channel assigned to memory refresh
ChipSet.DMA_FDC       = 0x02;   // DMA channel assigned to the Floppy Drive Controller (FDC)
ChipSet.DMA_HDC       = 0x03;   // DMA channel assigned to the Hard Drive Controller (HDC; XTC only)

/*
 * 8259A Programmable Interrupt Controller (PIC) I/O ports
 *
 * Internal registers:
 *
 *      ICW1    Initialization Command Word 1 (sent to port ChipSet.PIC_LO)
 *      ICW2    Initialization Command Word 2 (sent to port ChipSet.PIC_HI)
 *      ICW3    Initialization Command Word 3 (sent to port ChipSet.PIC_HI)
 *      ICW4    Initialization Command Word 4 (sent to port ChipSet.PIC_HI)
 *      IMR     Interrupt Mask Register
 *      IRR     Interrupt Request Register
 *      ISR     Interrupt Service Register
 *      IRLow   (IR having lowest priority; IR+1 will have highest priority; default is 7)
 *
 * Note that ICW2 effectively contains the starting IDT vector number (ie, for IRQ 0),
 * which must be multiplied by 4 to calculate the vector offset, since every vector is 4 bytes long.
 *
 * Also, since the low 3 bits of ICW2 are ignored in 8086/8088 mode (ie, they are effectively
 * treated as zeros), this means that the starting IDT vector can only be a multiple of 8.
 *
 * So, if ICW2 is set to 0x08, the starting vector number (ie, for IRQ 0) will be 0x08, and the
 * 4-byte address for the corresponding ISR will be located at offset 0x20 in the real-mode IDT.
 *
 * ICW4 is typically set to 0x09, indicating 8086 mode, non-automatic EOI, buffered/slave mode.
 *
 * TODO: Determine why the original ROM BIOS chose buffered/slave over buffered/master.
 * Did it simply not matter in pre-AT systems with only one PIC, or am I misreading something?
 *
 * TODO: Consider support for level-triggered PIC interrupts, even though the original IBM PCs
 * (up through MODEL_5170) used only edge-triggered interrupts.
 */
ChipSet.PIC0 = {                // all models: the "master" PIC
    INDEX:              0,
    PORT_LO:            0x20,
    PORT_HI:            0x21
};

ChipSet.PIC1 = {                // MODEL_5170 and up: the "slave" PIC
    INDEX:              1,
    PORT_LO:            0xA0,
    PORT_HI:            0xA1
};

ChipSet.PIC_LO = {              // ChipSet.PIC1.PORT_LO or ChipSet.PIC2.PORT_LO
    ICW1:               0x10,   // set means ICW1
    ICW1_ICW4:          0x01,   // ICW4 needed (otherwise ICW4 must be sent)
    ICW1_SNGL:          0x02,   // single PIC (and therefore no ICW3; otherwise there is another "cascaded" PIC)
    ICW1_ADI:           0x04,   // call address interval is 4 (otherwise 8; presumably ignored in 8086/8088 mode)
    ICW1_LTIM:          0x08,   // level-triggered interrupt mode (otherwise edge-triggered mode, which is what PCs use)
    OCW2:               0x00,   // bit 3 (PIC_LO.OCW3) and bit 4 (ChipSet.PIC_LO.ICW1) are clear in an OCW2 command byte
    OCW2_IR_LVL:        0x07,
    OCW2_OP_MASK:       0xE0,   // of the following valid OCW2 operations, the first 4 are EOI commands (all have ChipSet.PIC_LO.OCW2_EOI set)
    OCW2_EOI:           0x20,   // non-specific EOI (end-of-interrupt)
    OCW2_EOI_SPEC:      0x60,   // specific EOI
    OCW2_EOI_ROT:       0xA0,   // rotate on non-specific EOI
    OCW2_EOI_ROTSPEC:   0xE0,   // rotate on specific EOI
    OCW2_SET_ROTAUTO:   0x80,   // set rotate in automatic EOI mode
    OCW2_CLR_ROTAUTO:   0x00,   // clear rotate in automatic EOI mode
    OCW2_SET_PRI:       0xC0,   // bits 0-2 specify the lowest priority interrupt
    OCW3:               0x08,   // bit 3 (PIC_LO.OCW3) is set and bit 4 (PIC_LO.ICW1) clear in an OCW3 command byte (bit 7 should be clear, too)
    OCW3_READ_IRR:      0x02,   // read IRR register
    OCW3_READ_ISR:      0x03,   // read ISR register
    OCW3_READ_CMD:      0x03,
    OCW3_POLL_CMD:      0x04,   // poll
    OCW3_SMM_RESET:     0x40,   // special mask mode: reset
    OCW3_SMM_SET:       0x60,   // special mask mode: set
    OCW3_SMM_CMD:       0x60
};

ChipSet.PIC_HI = {              // ChipSet.PIC1.PORT_HI or ChipSet.PIC2.PORT_HI
    ICW2_VECTOR:        0xF8,   // starting vector number (bits 0-2 are effectively treated as zeros in 8086/8088 mode)
    ICW4_8086:          0x01,
    ICW4_AUTO_EOI:      0x02,
    ICW4_MASTER:        0x04,
    ICW4_BUFFERED:      0x08,
    ICW4_FULLY_NESTED:  0x10,
    OCW1_IMR:           0xFF
};

/*
 * The priorities of IRQs 0-7 are normally high to low, unless the master PIC has been reprogrammed.
 * Also, if a slave PIC is present, the priorities of IRQs 8-15 fall between the priorities of IRQs 1 and 3.
 *
 * As the MODEL_5170 TechRef states:
 *
 *      "Interrupt requests are prioritized, with IRQ9 through IRQ12 and IRQ14 through IRQ15 having the
 *      highest priority (IRQ9 is the highest) and IRQ3 through IRQ7 having the lowest priority (IRQ7 is
 *      the lowest).
 *
 *      Interrupt 13 (IRQ.FPU) is used on the system board and is not available on the I/O channel.
 *      Interrupt 8 (IRQ.RTC) is used for the real-time clock."
 *
 * This priority scheme is a byproduct of IRQ8 through IRQ15 (slave PIC interrupts) being tied to IRQ2 of
 * the master PIC.  As a result, the two other system board interrupts, IRQ0 and IRQ1, continue to have the
 * highest priority, by default.
 */
ChipSet.IRQ = {
    TIMER0:             0x00,
    KBD:                0x01,
    SLAVE:              0x02,   // MODEL_5170
    COM2:               0x03,
    COM1:               0x04,
    XTC:                0x05,   // MODEL_5160 uses IRQ 5 for HDC (XTC version)
    LPT2:               0x05,   // MODEL_5170 uses IRQ 5 for LPT2
    FDC:                0x06,
    LPT1:               0x07,
    RTC:                0x08,   // MODEL_5170
    IRQ2:               0x09,   // MODEL_5170
    FPU:                0x0D,   // MODEL_5170
    ATC:                0x0E    // MODEL_5170 uses IRQ 14 for HDC (ATC version)
};

/*
 * 8253 Programmable Interval Timer (PIT) I/O ports
 *
 * Although technically, a PIT provides 3 "counters" rather than 3 "timers", we have
 * adopted IBM's TechRef nomenclature, which refers to the PIT's counters as TIMER0,
 * TIMER1, and TIMER2.  For machines with a second PIT (eg, the DeskPro 386), we refer
 * to those additional counters as TIMER3, TIMER4, and TIMER5.
 *
 * In addition, if there's a need to refer to a specific PIT, use PIT0 for the first PIT
 * and PIT1 for the second.  This mirrors how we refer to multiple DMA controllers
 * (eg, DMA0 and DMA1) and multiple PICs (eg, PIC0 and PIC1).
 *
 * This differs from COMPAQ's nomenclature, which used "Timer 1" to refer to the first
 * PIT, and "Timer 2" for the second PIT, and then referred to "Counter 0", "Counter 1",
 * and "Counter 2" within each PIT.
 */
ChipSet.PIT0 = {
    PORT:               0x40,
    INDEX:              0,
    TIMER0:             0,      // used for time-of-day (prior to MODEL_5170)
    TIMER1:             1,      // used for memory refresh
    TIMER2:             2       // used for speaker tone generation
};

ChipSet.PIT1 = {
    PORT:               0x48,   // MODEL_COMPAQ_DESKPRO386 only
    INDEX:              1,
    TIMER3:             0,      // used for fail-safe clock
    TIMER4:             1,      // N/A
    TIMER5:             2       // used for refresher request extend/speed control
};

ChipSet.PIT_CTRL = {
    PORT1:              0x43,   // write-only control register (use the Read-Back command to get status)
    PORT2:              0x4B,   // write-only control register (use the Read-Back command to get status)
    BCD:                0x01,
    MODE:               0x0E,
    MODE0:              0x00,   // interrupt on Terminal Count (TC)
    MODE1:              0x02,   // programmable one-shot
    MODE2:              0x04,   // rate generator
    MODE3:              0x06,   // square wave generator
    MODE4:              0x08,   // software-triggered strobe
    MODE5:              0x0A,   // hardware-triggered strobe
    RW:                 0x30,
    RW_LATCH:           0x00,
    RW_LSB:             0x10,
    RW_MSB:             0x20,
    RW_BOTH:            0x30,
    SC:                 0xC0,
    SC_CTR0:            0x00,
    SC_CTR1:            0x40,
    SC_CTR2:            0x80,
    SC_BACK:            0xC0,
    SC_SHIFT:           6,
    RB_CTR0:            0x02,
    RB_CTR1:            0x04,
    RB_CTR2:            0x08,
    RB_STATUS:          0x10,   // if this bit is CLEAR, then latch the current status of the selected counter(s)
    RB_COUNTS:          0x20,   // if this bit is CLEAR, then latch the current count(s) of the selected counter(s)
    RB_NULL:            0x40,   // bit set in Read-Back status byte if the counter has not been "fully loaded" yet
    RB_OUT:             0x80    // bit set in Read-Back status byte if fOUT is true
};

ChipSet.TIMER_TICKS_PER_SEC = 1193181;

/*
 * 8255A Programmable Peripheral Interface (PPI) I/O ports, for Cassette/Speaker/Keyboard/SW1/etc
 *
 * Normally, 0x99 is written to PPI_CTRL.PORT, indicating that PPI_A.PORT and PPI_C.PORT are INPUT ports
 * and PPI_B.PORT is an OUTPUT port.
 *
 * However, the MODEL_5160 ROM BIOS initially writes 0x89 instead, making PPI_A.PORT an OUTPUT port.
 * I'm guessing that's just part of some "diagnostic mode", because all it writes to PPI_A.PORT are a series
 * of "checkpoint" values (ie, 0x01, 0x02, and 0x03) before updating PPI_CTRL.PORT with the usual 0x99.
 */
ChipSet.PPI_A = {               // this.bPPIA (port 0x60)
    PORT:               0x60    // INPUT: keyboard scan code (PPI_B.CLEAR_KBD must be clear)
};

ChipSet.PPI_B = {               // this.bPPIB (port 0x61)
    PORT:               0x61,   // OUTPUT (although it has to be treated as INPUT, too; the keyboard interrupt handler reads it, OR's PPI_B.CLEAR_KBD, writes it, and then rewrites the original read value)
    CLK_TIMER2:         0x01,   // ALL: set to enable clock to TIMER2
    SPK_TIMER2:         0x02,   // ALL: set to connect output of TIMER2 to speaker (MODEL_5150: clear for cassette)
    ENABLE_SW2:         0x04,   // MODEL_5150: set to enable SW2[1-4] through PPI_C.PORT, clear to enable SW2[5]; MODEL_5160: unused (there is no SW2 switch block on the MODEL_5160 motherboard)
    CASS_MOTOR_OFF:     0x08,   // MODEL_5150: cassette motor off
    ENABLE_SW_HI:       0x08,   // MODEL_5160: clear to read SW1[1-4], set to read SW1[5-8]
    DISABLE_RW_MEM:     0x10,   // ALL: clear to enable RAM parity check, set to disable
    DISABLE_IO_CHK:     0x20,   // ALL: clear to enable I/O channel check, set to disable
    CLK_KBD:            0x40,   // ALL: clear to force keyboard clock low
    CLEAR_KBD:          0x80    // ALL: clear to enable keyboard scan codes (MODEL_5150: set to enable SW1 through PPI_A.PORT)
};

ChipSet.PPI_C = {               // this.bPPIC (port 0x62)
    PORT:               0x62,   // INPUT (see below)
    SW:                 0x0F,   // MODEL_5150: SW2[1-4] or SW2[5], depending on whether PPI_B.ENABLE_SW2 is set or clear; MODEL_5160: SW1[1-4] or SW1[5-8], depending on whether PPI_B.ENABLE_SW_HI is clear or set
    CASS_DATA_IN:       0x10,
    TIMER2_OUT:         0x20,
    IO_CHANNEL_CHK:     0x40,   // used by NMI handler to detect I/O channel errors
    RW_PARITY_CHK:      0x80    // used by NMI handler to detect R/W memory parity errors
};

ChipSet.PPI_CTRL = {            // this.bPPICtrl (port 0x63)
    PORT:               0x63,   // OUTPUT: initialized to 0x99, defining PPI_A and PPI_C as INPUT and PPI_B as OUTPUT
    A_IN:               0x10,
    B_IN:               0x02,
    C_IN_LO:            0x01,
    C_IN_HI:            0x08,
    B_MODE:             0x04,
    A_MODE:             0x60
};

/*
 * Switches Overview
 * -----------------
 *
 * The conventions used for the sw1 and sw2 strings are that the left-most character represents DIP switch [1],
 * the right-most character represents DIP switch [8], and "1" means the DIP switch is ON and "0" means it is OFF.
 *
 * Internally, we convert the above strings into binary values that the 8255A PPI returns, where DIP switch [1]
 * is bit 0 and DIP switch [8] is bit 7, and 0 indicates the switch is ON and 1 indicates it is OFF.
 *
 * For reference, here's how the SW1 and SW2 switches correspond to the internal 8255A PPI bit values:
 *
 *      SW1[1]    (bit 0)     "0xxxxxxx" (1):  IPL,  "1xxxxxxx" (0):  No IPL
 *      SW1[2]    (bit 1)     reserved on the 5150; OFF (1) if FPU installed in a 5160
 *      SW1[3,4]  (bits 3-2)  "xx11xxxx" (00): 16Kb, "xx01xxxx" (10): 32Kb,  "xx10xxxx" (01): 48Kb,  "xx00xxxx" (11): 64Kb
 *      SW1[5,6]  (bits 5-4)  "xxxx11xx" (00): none, "xxxx01xx" (10): tv,    "xxxx10xx" (01): color, "xxxx00xx" (11): mono
 *      SW1[7,8]  (bits 7-6)  "xxxxxx11" (00): 1 FD, "xxxxxx01" (10): 2 FD,  "xxxxxx10" (01): 3 FD,  "xxxxxx00" (11): 4 FD
 *
 * Note: FD refers to floppy drive, and IPL refers to an "Initial Program Load" floppy drive.
 *
 *      SW2[1-5]    (bits 4-0)  "NNNxxxxx": number of 32Kb blocks of I/O expansion RAM present
 *
 * For example, sw1="01110011" indicates that all SW1 DIP switches are ON, except for SW1[1], SW1[5] and SW1[6],
 * which are OFF.  Internally, the order of these bits must reversed (to 11001110) and then inverted (to 00110001)
 * to yield the value that the 8255A PPI returns.  Reading the final value right-to-left, 00110001 indicates an
 * IPL floppy drive, 1X of RAM (where X is 16Kb on a MODEL_5150 and 64Kb on a MODEL_5160), MDA, and 1 floppy drive.
 *
 * WARNING: It is possible to set SW1 to indicate more memory than the RAM component has been configured to provide.
 * This is a configuration error which will cause the machine to crash after reporting a "201" error code (memory
 * test failure), which is presumably what a real machine would do if it was similarly misconfigured.  Surprisingly,
 * the BIOS forges ahead, setting SP to the top of the memory range indicated by SW1 (via INT 0x12), but the lack of
 * a valid stack causes the system to crash after the next IRET.  The BIOS should have either halted or modified
 * the actual memory size to match the results of the memory test.
 *
 * MODEL 5150 Switches
 * -------------------
 *
 * PPI_SW bits are exposed via port PPI_A.
 *
 * MODEL 5160 Switches
 * ------------------------
 *
 * PPI_SW bits 0-3 are exposed via PPI_C.SW if PPI_B.ENABLE_SW_HI is clear; bits 4-7 if PPI_B.ENABLE_SW_HI is set.
 *
 * AT&T 6300 Switches
 * ------------------
 *
 * Based on ATT_PC_6300_Service_Manual.pdf, there are two 8-switch blocks, DIPSW-0 and DIPSW-1, where:
 *
 *      DIPSW-0[1-4] Total RAM
 *      DIPSW-0[5] - ON if 8087 not installed, OFF if installed
 *      DIPSW-0[6] - ON if 8250 ACE serial interface present, OFF if Z-8530 SCC interface present
 *      DIPSW-0[7] - Not used
 *      DIPSW-0[8] - Type of EPROM chip for ROM 1.21 or lower, or presence of RAM in bank 1 for ROM 1.43 or higher
 *
 * and:
 *
 *      DIPSW-1[1] - Floppy Type (ON for 48TPI, OFF for 96TPI)
 *      DIPSW-1[2] - Floppy Speed (ON for slow startup, OFF for fast startup)
 *      DIPSW-1[3] - HDU ROM (ON for indigenous, OFF for external)
 *      DIPSW-1[4] - Not used (ROM 1.21 or lower) or Scroll Speed (ROM 1.43 or higher: ON for fast, OFF for slow)
 *      DIPSW-1[5-6] - Display Type (11=EGA or none, 01=color 40x25, 10=color 80x25, 00=monochrome 80x25)
 *      DIPSW-1[7-8] - Number of Floppy Drives (11=one, 01=two, 10=three, 00=four)
 *
 * For AT&T 6300 ROM 1.43 and up, DIPSW-0 supports the following RAM combinations:
 *
 *      0111xxx1: 128Kb on motherboard
 *      1011xxx0: 256Kb on motherboard
 *      1101xxx0: 256Kb on motherboard, 256Kb on expansion board (512Kb total)
 *      1110xxx1: 512Kb on motherboard
 *      0101xxx0: 256Kb on motherboard, 384Kb on expansion board (640Kb total)
 *      0100xxx0: 640Kb on motherboard (128Kb bank 0, 512Kb bank 1)
 *      0110xxx0: 640Kb on motherboard (512Kb bank 0, 128Kb bank 1)
 *
 * Inspection of the AT&T 6300 Plus ROM BIOS reveals that DIPSW-0[1-8] are obtained from bits 0-7
 * of port 0x66 ("sys_conf_a") and DIPSW-1[1-8] are obtained from bits 0-7 of port 0x67 ("sys_conf_b").
 */

ChipSet.PPI_SW = {
    FDRIVE: {
        IPL:            0x01,   // MODEL_5150: IPL ("Initial Program Load") floppy drive attached; MODEL_5160: "Loop on POST"
        ONE:            0x00,   // 1 floppy drive attached (or 0 drives if PPI_SW.FDRIVE_IPL is not set -- MODEL_5150 only)
        TWO:            0x40,   // 2 floppy drives attached
        THREE:          0x80,   // 3 floppy drives attached
        FOUR:           0xC0,   // 4 floppy drives attached
        MASK:           0xC0,
        SHIFT:          6
    },
    FPU:                0x02,   // MODEL_5150: reserved; MODEL_5160: FPU coprocessor installed
    MEMORY: {                   // MODEL_5150: "X" is 16Kb; MODEL_5160: "X" is 64Kb
        X1:             0x00,   // 16Kb or 64Kb
        X2:             0x04,   // 32Kb or 128Kb
        X3:             0x08,   // 48Kb or 192Kb
        X4:             0x0C,   // 64Kb or 256Kb
        MASK:           0x0C,
        SHIFT:          2
    },
    MONITOR: {
        TV:             0x10,
        COLOR:          0x20,
        MONO:           0x30,
        MASK:           0x30,
        SHIFT:          4
    }
};

/*
 * Some models have completely different DIP switch implementations from the MODEL_5150, which, being
 * the first IBM PC, was the model that we, um, modeled our DIP switch support on.  So, to support other
 * implementations, we now get and set DIP switch values according to SWITCH_TYPE, and rely on the
 * tables that follow to define which DIP switch(es) correspond to each SWITCH_TYPE.
 *
 * Not every model needs its own tables.  The getDIPSwitches() and setDIPSwitches() functions look first
 * for an *exact* model match, then a "truncated" model match, and failing that, they fall back to the
 * MODEL_5150 switch definitions.
 */
ChipSet.SWITCH_TYPE = {
    FLOPNUM:    1,
    FLOPTYPE:   2,
    FPU:        3,
    MONITOR:    4,
    LOWMEM:     5,
    EXPMEM:     6
};

ChipSet.DIPSW = {};
ChipSet.DIPSW[ChipSet.MODEL_5150] = [{},{}];
ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.FLOPNUM] = {
    MASK:       0xC0,
    VALUES: {
        1:      0x00,
        2:      0x40,
        3:      0x80,
        4:      0xC0
    },
    LABEL: "Number of Floppy Drives"
};
/*
 * NOTE: Both the Aug 1981 and the Apr 1984 IBM 5150 Technical Reference Manuals list SW1[2] as "RESERVED",
 * but the Aug 1981 edition (p. 2-28) also says SW1[2] "MUST BE ON (RESERVED FOR CO-PROCESSOR)".  Contemporary
 * articles discussing 8087 support in early PCs all indicate that switch SW1[2] must OFF if a coprocessor
 * is installed, and the 1984 5150 Guide to Operations (p. 5-34) confirms it.
 *
 * The Aug 1981 5150 TechRef makes no further mention of coprocessor support, whereas the Apr 1984 5150 TechRef
 * discusses it in a fair bit of detail, including the fact that 8087 exceptions generate an NMI, despite Intel's
 * warning in their iAPX 86,88 User's Manual, p. S-27, that "[t]he 8087 should not be tied to the CPU's NMI
 * (non-maskable interrupt) line.")
 */
ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.FPU] = {
    MASK:       0x02,
    VALUES: {
        0:      0x00,   // 0 means an FPU is NOT installed
        1:      0x02    // 1 means an FPU is installed
    },
    LABEL: "FPU"
};
ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.MONITOR] = {
    MASK:       0x30,
    VALUES: {
        0:      0x00,
        1:      0x10,
        2:      0x20,
        3:      0x30,
        "none": 0x00,
        "tv":   0x10,   // aka composite
        "color":0x20,
        "cga":  0x20,   // alias for color
        "mda":  0x30,   // alias for mono
        "mono": 0x30,
        "ega":  0x00,
        "vga":  0x00
    },
    LABEL: "Monitor Type"
};
ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.LOWMEM] = {
    MASK:       0x0C,
    VALUES: {
        16:     0x00,
        32:     0x04,
        48:     0x08,
        64:     0x0C
    },
    LABEL: "Base Memory (16Kb Increments)"
};
ChipSet.DIPSW[ChipSet.MODEL_5150][1][ChipSet.SWITCH_TYPE.EXPMEM] = {
    MASK:       0x1F,   // technically, this mask should be 0x0F for ROM revisions prior to 5150_REV3, and 0x1F on 5150_REV3
    VALUES: {
        0:      0x00,
        32:     0x01,
        64:     0x02,
        96:     0x03,
        128:    0x04,
        160:    0x05,
        192:    0x06,
        224:    0x07,
        256:    0x08,
        288:    0x09,
        320:    0x0A,
        352:    0x0B,
        384:    0x0C,
        416:    0x0D,
        448:    0x0E,
        480:    0x0F,
        512:    0x10,
        544:    0x11,
        576:    0x12
        /*
         * Obviously, more bit combinations are possible here (up to 0x1F), but assuming a minimum of 64Kb already on
         * the motherboard, any amount of expansion memory above 576Kb would break the 640Kb barrier.  Yes, if you used
         * only MDA or CGA video cards, you could go as high as 704Kb in a real system.  But in our happy little world,
         * this is where we stop.
         *
         * TODO: A value larger than 0x12 usually comes from a misconfigured machine (ie, it forgot to leave SW2[5] ON).
         * To compensate, when getDIPMemorySize() gets null back from its EXPMEM request, perhaps it should try truncating
         * the DIP switch value.  However, that would introduce a machine-specific hack into a function that's supposed
         * be machine-independent now.
         */
    },
    LABEL: "Expansion Memory (32Kb Increments)"
};

ChipSet.DIPSW[ChipSet.MODEL_5160] = [{},{}];
ChipSet.DIPSW[ChipSet.MODEL_5160][0][ChipSet.SWITCH_TYPE.FLOPNUM] = ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.FLOPNUM];
ChipSet.DIPSW[ChipSet.MODEL_5160][0][ChipSet.SWITCH_TYPE.FPU]     = ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.FPU];
ChipSet.DIPSW[ChipSet.MODEL_5160][0][ChipSet.SWITCH_TYPE.MONITOR] = ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.MONITOR];
ChipSet.DIPSW[ChipSet.MODEL_5160][0][ChipSet.SWITCH_TYPE.LOWMEM]  = {
    MASK:       0x0C,
    VALUES: {
        64:     0x00,
        128:    0x04,
        192:    0x08,
        256:    0x0C
    },
    LABEL: "Base Memory (64Kb Increments)"
};
ChipSet.DIPSW[ChipSet.MODEL_5160][1][ChipSet.SWITCH_TYPE.EXPMEM]  = ChipSet.DIPSW[ChipSet.MODEL_5150][1][ChipSet.SWITCH_TYPE.EXPMEM];

ChipSet.DIPSW[ChipSet.MODEL_ATT_6300] = [{},{}];
ChipSet.DIPSW[ChipSet.MODEL_ATT_6300][0][ChipSet.SWITCH_TYPE.LOWMEM] = {
    MASK:       0x8F,
    VALUES: {
        128:    0x01,   // "0111xxx1"
        256:    0x82,   // "1011xxx0"
        512:    0x08,   // "1110xxx1"
        640:    0x8D    // "0100xxx0"
    },
    LABEL: "Base Memory (128Kb Increments)"
};
ChipSet.DIPSW[ChipSet.MODEL_ATT_6300][0][ChipSet.SWITCH_TYPE.FPU] = {
    MASK:       0x10,
    VALUES: {
        0:      0x00,
        1:      0x10
    },
    LABEL: "FPU"
};
ChipSet.DIPSW[ChipSet.MODEL_ATT_6300][1][ChipSet.SWITCH_TYPE.FLOPTYPE] = {
    MASK:       0x01,
    VALUES: {
        0:      0x00,
        1:      0x01
    },
    LABEL: "Floppy Type"
};
ChipSet.DIPSW[ChipSet.MODEL_ATT_6300][1][ChipSet.SWITCH_TYPE.FLOPNUM] = ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.FLOPNUM];
ChipSet.DIPSW[ChipSet.MODEL_ATT_6300][1][ChipSet.SWITCH_TYPE.MONITOR] = ChipSet.DIPSW[ChipSet.MODEL_5150][0][ChipSet.SWITCH_TYPE.MONITOR];

/*
 * 8041 Keyboard Controller I/O ports (MODEL_ATT_6300)
 *
 * The AT&T 6300 uses an 8041 for its Keyboard Controller, which has the following ports:
 *
 *      Port    Description
 *      ----    -----------
 *      0x60    Keyboard Scan Code (input)
 *      0x61    Keyboard Control Port (output)
 *      0x64    Keyboard Status Port (input)
 *
 * And the Keyboard Control Port (0x61) has the following bit definitions:
 *
 *      0x01    Speaker gate to 8253 (counter 2)
 *      0x02    Speaker data
 *      0x0C    Not used
 *      0x10    RAM Parity (NMI) Enable
 *      0x20    I/O Channel (NMI) Enable
 *      0x40    Keyboard Clock Reset
 *      0x80    Reset Interrupt Pending
 */

/*
 * 8042 Keyboard Controller I/O ports (MODEL_5170)
 *
 * On the MODEL_5170, port 0x60 is designated KC8042.DATA rather than PPI_A, although the BIOS also refers to it
 * as "PORT_A: 8042 KEYBOARD SCAN/DIAG OUTPUTS").  This is the 8042's output buffer and should be read only when
 * KC8042.STATUS.OUTBUFF_FULL is set.
 *
 * Similarly, port 0x61 is designated KC8042.RWREG rather than PPI_B; the BIOS also refers to it as "PORT_B: 8042
 * READ WRITE REGISTER", but it is not otherwise discussed in the MODEL_5170 TechRef's 8042 documentation.
 *
 * There are brief references to bits 0 and 1 (KC8042.RWREG.CLK_TIMER2 and KC8042.RWREG.SPK_TIMER2), and the BIOS sets
 * bits 2-7 to "DISABLE PARITY CHECKERS" (principally KC8042.RWREG.DISABLE_NMI, which are bits 2 and 3); why the BIOS
 * also sets bits 4-7 (or if those bits are even settable) is unclear, since it uses 11111100b rather than defined
 * constants.
 *
 * The bottom line: on a MODEL_5170, port 0x61 is still used for speaker control and parity checking, so we use
 * the same register (bPPIB) but install different I/O handlers.  It's also bi-directional: at one point, the BIOS
 * reads KC8042.RWREG.REFRESH_BIT (bit 4) to verify that it's alternating.
 *
 * PPI_C and PPI_CTRL don't seem to be documented or used by the MODEL_5170 BIOS, so I'm assuming they're obsolete.
 *
 * NOTE: For more information on the 8042 Controller, including information on undocumented commands, refer to the
 * documents in /devices/pc/keyboard, as well as the following websites:
 *
 *      http://halicery.com/8042/8042_INTERN_TXT.htm
 *      http://www.os2museum.com/wp/ibm-pcat-8042-keyboard-controller-commands/
 */
ChipSet.KC8042 = {
    DATA: {                     // this.b8042OutBuff (PPI_A on previous models, still referred to as "PORT A" by the MODEL_5170 BIOS)
        PORT:           0x60,
        CMD: {                  // this.b8042CmdData (KC8042.DATA.CMD "data bytes" written to port 0x60, after writing a KC8042.CMD byte to port 0x64)
            INT_ENABLE: 0x01,   // generate an interrupt when the controller places data in the output buffer
            SYS_FLAG:   0x04,   // this value is propagated to ChipSet.KC8042.STATUS.SYS_FLAG
            NO_INHIBIT: 0x08,   // disable inhibit function
            NO_CLOCK:   0x10,   // disable keyboard by driving "clock" line low
            PC_MODE:    0x20,
            PC_COMPAT:  0x40    // generate IBM PC-compatible scan codes
        },
        SELF_TEST: {            // result of ChipSet.KC8042.CMD.SELF_TEST command (0xAA)
            OK:         0x55
        },
        INTF_TEST: {            // result of ChipSet.KC8042.CMD.INTF_TEST command (0xAB)
            OK:         0x00,   // no error
            CLOCK_LO:   0x01,   // keyboard clock line stuck low
            CLOCK_HI:   0x02,   // keyboard clock line stuck high
            DATA_LO:    0x03,   // keyboard data line stuck low
            DATA_HI:    0x04    // keyboard data line stuck high
        }
    },
    INPORT: {                   // this.b8042InPort
        COMPAQ_50MHZ:   0x01,   // 50Mhz system clock enabled (0=48Mhz); see COMPAQ 386/25 TechRef p2-106
        UNDEFINED:      0x02,   // undefined
        COMPAQ_NO80387: 0x04,   // 80387 coprocessor NOT installed; see COMPAQ 386/25 TechRef p2-106
        COMPAQ_NOWEITEK:0x08,   // Weitek coprocessor NOT installed; see COMPAQ 386/25 TechRef p2-106
        ENABLE_256KB:   0x10,   // enable 2nd 256Kb of system board RAM
        COMPAQ_HISPEED: 0x10,   // high-speed enabled (0=auto); see COMPAQ 386/25 TechRef p2-106
        MFG_OFF:        0x20,   // manufacturing jumper not installed
        COMPAQ_DIP5OFF: 0x20,   // system board DIP switch #5 OFF (0=ON); see COMPAQ 386/25 TechRef p2-106
        MONO:           0x40,   // monochrome monitor is primary display
        COMPAQ_NONDUAL: 0x40,   // COMPAQ Dual-Mode monitor NOT installed; see COMPAQ 386/25 TechRef p2-106
        KBD_UNLOCKED:   0x80    // keyboard not inhibited (in COMPAQ parlance: security lock is unlocked)
    },
    OUTPORT: {                  // this.b8042OutPort
        NO_RESET:       0x01,   // set by default
        A20_ON:         0x02,   // set by default
        COMPAQ_SLOWD:   0x08,   // SL0WD* NOT asserted (refer to timer 2, counter 2); see COMPAQ 386/25 TechRef p2-105
        OUTBUFF_FULL:   0x10,   // output buffer full
        INBUFF_EMPTY:   0x20,   // input buffer empty
        KBD_CLOCK:      0x40,   // keyboard clock (output)
        KBD_DATA:       0x80    // keyboard data (output)
    },
    TESTPORT: {                 // generated "on the fly"
        KBD_CLOCK:      0x01,   // keyboard clock (input)
        KBD_DATA:       0x02    // keyboard data (input)
    },
    RWREG: {                    // this.bPPIB (since CLK_TIMER2 and SPK_TIMER2 are in both PPI_B and RWREG)
        PORT:           0x61,
        CLK_TIMER2:     0x01,   // set to enable clock to TIMER2 (R/W)
        SPK_TIMER2:     0x02,   // set to connect output of TIMER2 to speaker (R/W)
        COMPAQ_FSNMI:   0x04,   // set to disable RAM/FS NMI (R/W, DESKPRO386)
        COMPAQ_IONMI:   0x08,   // set to disable IOCHK NMI (R/W, DESKPRO386)
        DISABLE_NMI:    0x0C,   // set to disable IOCHK and RAM/FS NMI, clear to enable (R/W)
        REFRESH_BIT:    0x10,   // 0 if RAM refresh occurring, 1 if RAM not in refresh cycle (R/O)
        OUT_TIMER2:     0x20,   // state of TIMER2 output signal (R/O, DESKPRO386)
        IOCHK_NMI:      0x40,   // IOCHK NMI (R/O); to reset, pulse bit 3 (0x08)
        RAMFS_NMI:      0x80,   // RAM/FS (parity or fail-safe) NMI (R/O); to reset, pulse bit 2 (0x04)
        NMI_ERROR:      0xC0
    },
    CMD: {                      // this.b8042InBuff (on write to port 0x64, interpret this as a CMD)
        PORT:           0x64,
        READ_CMD:       0x20,   // sends the current CMD byte (this.b8042CmdData) to KC8042.DATA.PORT
        WRITE_CMD:      0x60,   // followed by a command byte written to KC8042.DATA.PORT (see KC8042.DATA.CMD)
        COMPAQ_SLOWD:   0xA3,   // enable system slow down; see COMPAQ 386/25 TechRef p2-111
        COMPAQ_TOGGLE:  0xA4,   // toggle speed-control bit; see COMPAQ 386/25 TechRef p2-111
        COMPAQ_SPCREAD: 0xA5,   // special read of "port 2"; see COMPAQ 386/25 TechRef p2-111
        SELF_TEST:      0xAA,   // self-test (KC8042.DATA.SELF_TEST.OK is placed in the output buffer if no errors)
        INTF_TEST:      0xAB,   // interface test
        DIAG_DUMP:      0xAC,   // diagnostic dump
        DISABLE_KBD:    0xAD,   // disable keyboard
        ENABLE_KBD:     0xAE,   // enable keyboard
        READ_INPORT:    0xC0,   // read input port and place data in output buffer (use only if output buffer empty)
        READ_OUTPORT:   0xD0,   // read output port and place data in output buffer (use only if output buffer empty)
        WRITE_OUTPORT:  0xD1,   // next byte written to KC8042.DATA.PORT (port 0x60) is placed in the output port (see KC8042.OUTPORT)
        READ_TEST:      0xE0,
        PULSE_OUTPORT:  0xF0    // this is the 1st of 16 commands (0xF0-0xFF) that pulse bits 0-3 of the output port
    },
    STATUS: {                   // this.b8042Status (on read from port 0x64)
        PORT:           0x64,
        OUTBUFF_FULL:   0x01,
        INBUFF_FULL:    0x02,   // set if the controller has received but not yet read data from the input buffer (not normally set)
        SYS_FLAG:       0x04,
        CMD_FLAG:       0x08,   // set on write to KC8042.CMD (port 0x64), clear on write to KC8042.DATA (port 0x60)
        NO_INHIBIT:     0x10,   // (in COMPAQ parlance: security lock not engaged)
        XMT_TIMEOUT:    0x20,
        RCV_TIMEOUT:    0x40,
        PARITY_ERR:     0x80,   // last byte of data received had EVEN parity (ODD parity is normally expected)
        OUTBUFF_DELAY:  0x100
    }
};

/*
 * MC146818A RTC/CMOS Ports (MODEL_5170)
 *
 * Write a CMOS address to ChipSet.CMOS.ADDR.PORT, then read/write data from/to ChipSet.CMOS.DATA.PORT.
 *
 * The ADDR port also controls NMI: write an address with bit 7 clear to enable NMI or set to disable NMI.
 */
ChipSet.CMOS = {
    ADDR: {                     // this.bCMOSAddr
        PORT:           0x70,
        RTC_SEC:        0x00,
        RTC_SEC_ALRM:   0x01,
        RTC_MIN:        0x02,
        RTC_MIN_ALRM:   0x03,
        RTC_HOUR:       0x04,
        RTC_HOUR_ALRM:  0x05,
        RTC_WEEK_DAY:   0x06,
        RTC_MONTH_DAY:  0x07,
        RTC_MONTH:      0x08,
        RTC_YEAR:       0x09,
        STATUSA:        0x0A,
        STATUSB:        0x0B,
        STATUSC:        0x0C,
        STATUSD:        0x0D,
        DIAG:           0x0E,
        SHUTDOWN:       0x0F,
        FDRIVE:         0x10,
        HDRIVE:         0x12,   // bits 4-7 contain type of drive 0, bits 0-3 contain type of drive 1 (type 0 means none)
        EQUIP:          0x14,
        BASEMEM_LO:     0x15,
        BASEMEM_HI:     0x16,   // the BASEMEM values indicate the total Kb of base memory, up to 0x280 (640Kb)
        EXTMEM_LO:      0x17,
        EXTMEM_HI:      0x18,   // the EXTMEM values indicate the total Kb of extended memory, up to 0x3C00 (15Mb)
        EXTHDRIVE0:     0x19,   // if bits 4-7 of HDRIVE contains 15, then the type of drive 0 is stored here (16-255)
        EXTHDRIVE1:     0x1A,   // if bits 0-3 of HDRIVE contains 15, then the type of drive 1 is stored here (16-255)
        CHKSUM_HI:      0x2E,
        CHKSUM_LO:      0x2F,   // CMOS bytes included in the checksum calculation: 0x10-0x2D
        EXTMEM2_LO:     0x30,
        EXTMEM2_HI:     0x31,
        CENTURY_DATE:   0x32,   // BCD value for the current century (eg, 0x19 for 20th century, 0x20 for 21st century)
        BOOT_INFO:      0x33,   // 0x80 if 128Kb expansion memory installed, 0x40 if Setup Utility wants an initial setup message
        MASK:           0x3F,
        TOTAL:          0x40,
        NMI_DISABLE:    0x80
    },
    DATA: {                     // this.abCMOSData
        PORT:           0x71
    },
    STATUSA: {                  // abCMOSData[ChipSet.CMOS.ADDR.STATUSA]
        UIP:            0x80,   // bit 7: 1 indicates Update-In-Progress, 0 indicates date/time ready to read
        DV:             0x70,   // bits 6-4 (DV2-DV0) are programmed to 010 to select a 32.768Khz time base
        RS:             0x0F    // bits 3-0 (RS3-RS0) are programmed to 0110 to select a 976.562us interrupt rate
    },
    STATUSB: {                  // abCMOSData[ChipSet.CMOS.ADDR.STATUSB]
        SET:            0x80,   // bit 7: 1 to set any/all of the 14 time-bytes
        PIE:            0x40,   // bit 6: 1 for Periodic Interrupt Enable
        AIE:            0x20,   // bit 5: 1 for Alarm Interrupt Enable
        UIE:            0x10,   // bit 4: 1 for Update Interrupt Enable
        SQWE:           0x08,   // bit 3: 1 for Square Wave Enabled (as set by the STATUSA rate selection bits)
        BINARY:         0x04,   // bit 2: 1 for binary Date Mode, 0 for BCD Date Mode
        HOUR24:         0x02,   // bit 1: 1 for 24-hour mode, 0 for 12-hour mode
        DST:            0x01    // bit 0: 1 for Daylight Savings Time enabled
    },
    STATUSC: {                  // abCMOSData[ChipSet.CMOS.ADDR.STATUSC]
        IRQF:           0x80,   // bit 7: 1 indicates one or more of the following bits (PF, AF, UF) are set
        PF:             0x40,   // bit 6: 1 indicates Periodic Interrupt
        AF:             0x20,   // bit 5: 1 indicates Alarm Interrupt
        UF:             0x10,   // bit 4: 1 indicates Update Interrupt
        RESERVED:       0x0F
    },
    STATUSD: {                  // abCMOSData[ChipSet.CMOS.ADDR.STATUSD]
        VRB:            0x80,   // bit 7: 1 indicates Valid RAM Bit (0 implies power was and/or is lost)
        RESERVED:       0x7F
    },
    DIAG: {                     // abCMOSData[ChipSet.CMOS.ADDR.DIAG]
        RTCFAIL:        0x80,   // bit 7: 1 indicates RTC lost power
        CHKSUMFAIL:     0x40,   // bit 6: 1 indicates bad CMOS checksum
        CONFIGFAIL:     0x20,   // bit 5: 1 indicates bad CMOS configuration info
        MEMSIZEFAIL:    0x10,   // bit 4: 1 indicates memory size miscompare
        HDRIVEFAIL:     0x08,   // bit 3: 1 indicates hard drive controller or drive init failure
        TIMEFAIL:       0x04,   // bit 2: 1 indicates time failure
        RESERVED:       0x03
    },
    FDRIVE: {                   // abCMOSData[ChipSet.CMOS.ADDR.FDRIVE]
        D0_MASK:        0xF0,   // Drive 0 type in high nibble
        D1_MASK:        0x0F,   // Drive 1 type in lower nibble
        NONE:           0,      // no drive
        /*
         * There's at least one floppy drive type that IBM didn't bother defining a CMOS drive type for:
         * single-sided drives that were only capable of storing 160Kb (or 180Kb when using 9 sectors/track).
         * So, as you can see in getDIPFloppyDriveType(), we lump all standard diskette capacities <= 360Kb
         * into the FD360 bucket.
         */
        FD360:          1,      // 5.25-inch double-sided double-density (DSDD 48TPI) drive: 40 tracks, 9 sectors/track, 360Kb max
        FD1200:         2,      // 5.25-inch double-sided high-density (DSHD 96TPI) drive: 80 tracks, 15 sectors/track, 1200Kb max
        FD720:          3,      // 3.5-inch drive capable of storing 80 tracks and up to 9 sectors/track, 720Kb max
        FD1440:         4       // 3.5-inch drive capable of storing 80 tracks and up to 18 sectors/track, 1440Kb max
    },
    /*
     * HDRIVE types are defined by table in the HDC component, which uses setCMOSDriveType() to update the CMOS
     */
    HDRIVE: {                   // abCMOSData[ChipSet.CMOS.ADDR.HDRIVE]
        D0_MASK:        0xF0,   // Drive 0 type in high nibble
        D1_MASK:        0x0F    // Drive 1 type in lower nibble
    },
    /*
     * The CMOS equipment flags use the same format as the older PPI equipment flags
     */
    EQUIP: {                    // abCMOSData[ChipSet.CMOS.ADDR.EQUIP]
        MONITOR:        ChipSet.PPI_SW.MONITOR,         // PPI_SW.MONITOR.MASK == 0x30
        FPU:            ChipSet.PPI_SW.FPU,             // PPI_SW.FPU == 0x02
        FDRIVE:         ChipSet.PPI_SW.FDRIVE           // PPI_SW.FDRIVE.IPL == 0x01 and PPI_SW.FDRIVE.MASK = 0xC0
    }
};

/*
 * DMA Page Registers
 *
 * The MODEL_5170 TechRef lists 0x80-0x9F as the range for DMA page registers, but that may be a bit
 * overbroad.  There are a total of 8 (7 usable) DMA channels on the MODEL_5170, each of which has the
 * following assigned DMA page registers:
 *
 *      Channel #   Page Reg
 *      ---------   --------
 *          0         0x87
 *          1         0x83
 *          2         0x81
 *          3         0x82
 *          4         0x8F (not usable; the 5170 TechRef refers to this as the "Refresh" page register)
 *          5         0x8B
 *          6         0x89
 *          7         0x8A
 *
 * That leaves 0x80, 0x84, 0x85, 0x86, 0x88, 0x8C, 0x8D and 0x8E unaccounted for in the range 0x80-0x8F.
 * (I'm saving the question of what, if anything, is available in the range 0x90-0x9F for another day.)
 *
 * As for port 0x80, the TechRef says:
 *
 *      "I/O address hex 080 is used as a diagnostic-checkpoint port or register.
 *      This port corresponds to a read/write register in the DMA page register (74LS612)."
 *
 * so I used to have dedicated handlers and storage (bMFGData) for the register at port 0x80, but I've since
 * appended it to abDMAPageSpare, an 8-element array that captures all I/O to the 8 unassigned (aka "spare")
 * DMA page registers.  The 5170 BIOS uses 0x80 as a "checkpoint" register, and the DESKPRO386 uses 0x84 in a
 * similar fashion.  The 5170 also contains "MFG_TST" code that uses other unassigned DMA page registers as
 * scratch registers, which come in handy when RAM hasn't been tested/initialized yet.
 *
 * Here's our mapping of entries in the abDMAPageSpare array to the unassigned ("spare") DMA page registers:
 *
 *      Index #     Page Reg
 *      --------    --------
 *          0         0x84
 *          1         0x85
 *          2         0x86
 *          3         0x88
 *          4         0x8C
 *          5         0x8D
 *          6         0x8E
 *          7         0x80
 *
 * The only reason port 0x80 is out of sequence (ie, at the end of the array, at index 7 instead of index 0) is
 * because it was added the array later, and the entire array gets written to our save/restore data structures, so
 * reordering the elements would be a bad idea.
 */

/*
 * NMI Mask Register (MODEL_5150 and MODEL_5160 only)
 */
ChipSet.NMI = {                 // this.bNMI
    PORT:               0xA0,
    ENABLE:             0x80,
    DISABLE:            0x00
};

/*
 * FPU Coprocessor Control Registers (MODEL_5170)
 */
ChipSet.FPU = {                 // TODO: Define a variable for this?
    PORT_CLEAR:         0xF0,   // clear the FPU's "busy" state
    PORT_RESET:         0xF1    // reset the FPU
};

ChipSet.aDMAControllerInit = [0, null, null, 0, new Array(4), 0];

ChipSet.aDMAChannelInit = [true, [0,0], [0,0], [0,0], [0,0]];

ChipSet.aPICInit = [0, new Array(4)];

ChipSet.aTimerInit = [[0,0], [0,0], [0,0], [0,0]];

/*
 * Port input notification tables
 */
ChipSet.aPortInput = {
    0x00: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA0.INDEX, 0, port, addrFrom); },
    0x01: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA0.INDEX, 0, port, addrFrom); },
    0x02: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA0.INDEX, 1, port, addrFrom); },
    0x03: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA0.INDEX, 1, port, addrFrom); },
    0x04: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA0.INDEX, 2, port, addrFrom); },
    0x05: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA0.INDEX, 2, port, addrFrom); },
    0x06: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA0.INDEX, 3, port, addrFrom); },
    0x07: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA0.INDEX, 3, port, addrFrom); },
    0x08: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAStatus(ChipSet.DMA0.INDEX, port, addrFrom); },
    0x0D: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMATemp(ChipSet.DMA0.INDEX, port, addrFrom); },
    0x20: /** @this {ChipSet} */ function(port, addrFrom) { return this.inPICLo(ChipSet.PIC0.INDEX, addrFrom); },
    0x21: /** @this {ChipSet} */ function(port, addrFrom) { return this.inPICHi(ChipSet.PIC0.INDEX, addrFrom); },
    0x40: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimer(ChipSet.PIT0.INDEX, ChipSet.PIT0.TIMER0, port, addrFrom); },
    0x41: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimer(ChipSet.PIT0.INDEX, ChipSet.PIT0.TIMER1, port, addrFrom); },
    0x42: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimer(ChipSet.PIT0.INDEX, ChipSet.PIT0.TIMER2, port, addrFrom); },
    0x43: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimerCtrl(ChipSet.PIT0.INDEX, port, addrFrom); },
    0x81: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA0.INDEX, 2, port, addrFrom); },
    0x82: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA0.INDEX, 3, port, addrFrom); },
    0x83: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA0.INDEX, 1, port, addrFrom); },
    0x87: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA0.INDEX, 0, port, addrFrom); }
};

ChipSet.aPortInput5150 = {
    0x60: ChipSet.prototype.inPPIA,
    0x61: ChipSet.prototype.inPPIB,
    0x62: ChipSet.prototype.inPPIC,
    0x63: ChipSet.prototype.inPPICtrl   // technically, not actually readable, but I want the Debugger to be able to read it
};

ChipSet.aPortInput5170 = {
    0x60: ChipSet.prototype.in8042OutBuff,
    0x61: ChipSet.prototype.in8042RWReg,
    0x64: ChipSet.prototype.in8042Status,
    0x70: ChipSet.prototype.inCMOSAddr,
    0x71: ChipSet.prototype.inCMOSData,
    0x80: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(7, port, addrFrom); },
    0x84: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(0, port, addrFrom); },
    0x85: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(1, port, addrFrom); },
    0x86: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(2, port, addrFrom); },
    0x88: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(3, port, addrFrom); },
    0x89: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA1.INDEX, 2, port, addrFrom); },
    0x8A: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA1.INDEX, 3, port, addrFrom); },
    0x8B: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA1.INDEX, 1, port, addrFrom); },
    0x8C: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(4, port, addrFrom); },
    0x8D: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(5, port, addrFrom); },
    0x8E: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageSpare(6, port, addrFrom); },
    0x8F: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAPageReg(ChipSet.DMA1.INDEX, 0, port, addrFrom); },
    0xA0: /** @this {ChipSet} */ function(port, addrFrom) { return this.inPICLo(ChipSet.PIC1.INDEX, addrFrom); },
    0xA1: /** @this {ChipSet} */ function(port, addrFrom) { return this.inPICHi(ChipSet.PIC1.INDEX, addrFrom); },
    0xC0: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA1.INDEX, 0, port, addrFrom); },
    0xC2: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA1.INDEX, 0, port, addrFrom); },
    0xC4: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA1.INDEX, 1, port, addrFrom); },
    0xC6: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA1.INDEX, 1, port, addrFrom); },
    0xC8: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA1.INDEX, 2, port, addrFrom); },
    0xCA: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA1.INDEX, 2, port, addrFrom); },
    0xCC: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelAddr(ChipSet.DMA1.INDEX, 3, port, addrFrom); },
    0xCE: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAChannelCount(ChipSet.DMA1.INDEX, 3, port, addrFrom); },
    0xD0: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMAStatus(ChipSet.DMA1.INDEX, port, addrFrom); },
    0xDA: /** @this {ChipSet} */ function(port, addrFrom) { return this.inDMATemp(ChipSet.DMA1.INDEX, port, addrFrom); }
};

ChipSet.aPortInput6300 = {
    0x60: ChipSet.prototype.in8041Kbd,
    0x61: ChipSet.prototype.in8041Ctrl,
    0x64: ChipSet.prototype.in8041Status,
    0x66: /** @this {ChipSet} */ function(port, addrFrom) { return this.in6300DIPSwitches(0, port, addrFrom); },
    0x67: /** @this {ChipSet} */ function(port, addrFrom) { return this.in6300DIPSwitches(1, port, addrFrom); }
};

if (DESKPRO386) {
    ChipSet.aPortInputDeskPro386 = {
        0x48: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimer(ChipSet.PIT1.INDEX, ChipSet.PIT1.TIMER3, port, addrFrom); },
        0x49: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimer(ChipSet.PIT1.INDEX, ChipSet.PIT1.TIMER4, port, addrFrom); },
        0x4A: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimer(ChipSet.PIT1.INDEX, ChipSet.PIT1.TIMER5, port, addrFrom); },
        0x4B: /** @this {ChipSet} */ function(port, addrFrom) { return this.inTimerCtrl(ChipSet.PIT1.INDEX, port, addrFrom); }
    };
}

/*
 * Port output notification tables
 */
ChipSet.aPortOutput = {
    0x00: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA0.INDEX, 0, port, bOut, addrFrom); },
    0x01: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA0.INDEX, 0, port, bOut, addrFrom); },
    0x02: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA0.INDEX, 1, port, bOut, addrFrom); },
    0x03: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA0.INDEX, 1, port, bOut, addrFrom); },
    0x04: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA0.INDEX, 2, port, bOut, addrFrom); },
    0x05: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA0.INDEX, 2, port, bOut, addrFrom); },
    0x06: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA0.INDEX, 3, port, bOut, addrFrom); },
    0x07: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA0.INDEX, 3, port, bOut, addrFrom); },
    0x08: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMACmd(ChipSet.DMA0.INDEX, port, bOut, addrFrom); },
    0x09: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAReq(ChipSet.DMA0.INDEX, port, bOut, addrFrom); },
    0x0A: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAMask(ChipSet.DMA0.INDEX, port, bOut, addrFrom); },
    0x0B: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAMode(ChipSet.DMA0.INDEX, port, bOut, addrFrom); },
    0x0C: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAResetFF(ChipSet.DMA0.INDEX, port, bOut, addrFrom); },
    0x0D: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAMasterClear(ChipSet.DMA0.INDEX, port, bOut, addrFrom); },
    0x20: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outPICLo(ChipSet.PIC0.INDEX, bOut, addrFrom); },
    0x21: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outPICHi(ChipSet.PIC0.INDEX, bOut, addrFrom); },
    0x40: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimer(ChipSet.PIT0.INDEX, ChipSet.PIT0.TIMER0, port, bOut, addrFrom); },
    0x41: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimer(ChipSet.PIT0.INDEX, ChipSet.PIT0.TIMER1, port, bOut, addrFrom); },
    0x42: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimer(ChipSet.PIT0.INDEX, ChipSet.PIT0.TIMER2, port, bOut, addrFrom); },
    0x43: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimerCtrl(ChipSet.PIT0.INDEX, port, bOut, addrFrom); },
    0x81: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA0.INDEX, 2, port, bOut, addrFrom); },
    0x82: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA0.INDEX, 3, port, bOut, addrFrom); },
    0x83: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA0.INDEX, 1, port, bOut, addrFrom); },
    0x87: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA0.INDEX, 0, port, bOut, addrFrom); }
};

ChipSet.aPortOutput5150 = {
    0x60: ChipSet.prototype.outPPIA,
    0x61: ChipSet.prototype.outPPIB,
    0x62: ChipSet.prototype.outPPIC,
    0x63: ChipSet.prototype.outPPICtrl,
    0xA0: ChipSet.prototype.outNMI
};

ChipSet.aPortOutput5170 = {
    0x60: ChipSet.prototype.out8042InBuffData,
    0x61: ChipSet.prototype.out8042RWReg,
    0x64: ChipSet.prototype.out8042InBuffCmd,
    0x70: ChipSet.prototype.outCMOSAddr,
    0x71: ChipSet.prototype.outCMOSData,
    0x80: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(7, port, bOut, addrFrom); },
    0x84: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(0, port, bOut, addrFrom); },
    0x85: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(1, port, bOut, addrFrom); },
    0x86: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(2, port, bOut, addrFrom); },
    0x88: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(3, port, bOut, addrFrom); },
    0x89: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA1.INDEX, 2, port, bOut, addrFrom); },
    0x8A: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA1.INDEX, 3, port, bOut, addrFrom); },
    0x8B: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA1.INDEX, 1, port, bOut, addrFrom); },
    0x8C: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(4, port, bOut, addrFrom); },
    0x8D: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(5, port, bOut, addrFrom); },
    0x8E: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageSpare(6, port, bOut, addrFrom); },
    0x8F: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAPageReg(ChipSet.DMA1.INDEX, 0, port, bOut, addrFrom); },
    0xA0: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outPICLo(ChipSet.PIC1.INDEX, bOut, addrFrom); },
    0xA1: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outPICHi(ChipSet.PIC1.INDEX, bOut, addrFrom); },
    0xC0: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA1.INDEX, 0, port, bOut, addrFrom); },
    0xC2: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA1.INDEX, 0, port, bOut, addrFrom); },
    0xC4: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA1.INDEX, 1, port, bOut, addrFrom); },
    0xC6: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA1.INDEX, 1, port, bOut, addrFrom); },
    0xC8: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA1.INDEX, 2, port, bOut, addrFrom); },
    0xCA: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA1.INDEX, 2, port, bOut, addrFrom); },
    0xCC: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelAddr(ChipSet.DMA1.INDEX, 3, port, bOut, addrFrom); },
    0xCE: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAChannelCount(ChipSet.DMA1.INDEX, 3, port, bOut, addrFrom); },
    0xD0: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMACmd(ChipSet.DMA1.INDEX, port, bOut, addrFrom); },
    0xD2: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAReq(ChipSet.DMA1.INDEX, port, bOut, addrFrom); },
    0xD4: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAMask(ChipSet.DMA1.INDEX, port, bOut, addrFrom); },
    0xD6: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAMode(ChipSet.DMA1.INDEX, port, bOut, addrFrom); },
    0xD8: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAResetFF(ChipSet.DMA1.INDEX, port, bOut, addrFrom); },
    0xDA: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outDMAMasterClear(ChipSet.DMA1.INDEX, port, bOut, addrFrom); },
    0xF0: ChipSet.prototype.outFPUClear,
    0xF1: ChipSet.prototype.outFPUReset
};

ChipSet.aPortOutput6300 = {
    0x60: ChipSet.prototype.out8041Kbd,
    0x61: ChipSet.prototype.out8041Ctrl,
    0xA0: ChipSet.prototype.outNMI
};

if (DESKPRO386) {
    ChipSet.aPortOutputDeskPro386 = {
        0x48: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimer(ChipSet.PIT1.INDEX, ChipSet.PIT1.TIMER3, port, bOut, addrFrom); },
        0x49: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimer(ChipSet.PIT1.INDEX, ChipSet.PIT1.TIMER4, port, bOut, addrFrom); },
        0x4A: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimer(ChipSet.PIT1.INDEX, ChipSet.PIT1.TIMER5, port, bOut, addrFrom); },
        0x4B: /** @this {ChipSet} */ function(port, bOut, addrFrom) { this.outTimerCtrl(ChipSet.PIT1.INDEX, port, bOut, addrFrom); }
    };
}

/*
 * Initialize every ChipSet module on the page.
 */
Web.onInit(ChipSet.init);

if (NODE) module.exports = ChipSet;
