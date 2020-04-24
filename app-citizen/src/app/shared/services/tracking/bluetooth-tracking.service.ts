import {Inject, Injectable} from "@angular/core";
import {BluetoothLE} from "@ionic-native/bluetooth-le/ngx";
import {Platform} from "@ionic/angular";
import {BehaviorSubject, Subject} from "rxjs";
import {BLE} from "@ionic-native/ble/ngx";
import {ContactTrackerService} from "../contacts/contact-tracker.service";
import {PatientService} from "../patient.service";
import { PermissionsService } from '../permissions.service';
import {Plugins} from "@capacitor/core";

const { App, BackgroundTask } = Plugins;

@Injectable()
export class BluetoothTrackingService {

    public btEnabled$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

    private patientServiceUUID;

    protected addressesBeingTracked = new Map<string, boolean>();

    public static serviceUUID = "C0C0C0C0-DEE8-B109-8DB0-3DBD690003C0";
    public static timeScanningInMillis = 15000;
    public static timeWithoutScanningInMillis = 30000;

    protected myAddress;

    protected activated = false;

    protected isScanning = false;
    protected isAdvertising = false;
    protected scanTimeout;
    protected backgroundMode = false;

    protected restoreKey = "Open Coronavirus";

    constructor(protected bluetoothle: BluetoothLE,
                protected ble: BLE,
                protected platform: Platform,
                protected patientService: PatientService,
                protected permissionsService: PermissionsService,
                @Inject('settings') protected settings,
                protected contactTrackerService: ContactTrackerService
    ) {

    }

    public startBluetoothTracking() {

        this.prepareBackgroundMode();

        this.bluetoothle.getAdapterInfo().then(result => {
            console.debug("[BluetoothLE] Device info: " + JSON.stringify(result));
        });

        this.btEnabled$.next(true);

        /*

        if(this.settings.enabled.bluetooth && this.activated == false) {
            this.activated = true;

            this.patientService.patientLoaded$.subscribe(loaded => {

                if (loaded && this.patientService.patient != null && this.patientService.patient.id != null) {

                    this.patientServiceUUID = this.patientService.patient.serviceAdvertisementUUID;

                    this.platform.ready().then((readySource) => {

                        console.debug("[BluetoothLE] Initialize bluetooth LE ...");

                        // request => true / false (default) - Should user be prompted to enable Bluetooth
                        // statusReceiver => true / false (default) - Should change in Bluetooth status notifications be sent.
                        // restoreKey => A unique string to identify your app. Bluetooth Central background mode is required to
                        // use this, but background mode doesn't seem to require specifying the restoreKey.
                        let params = {request: true, statusReceiver: false, restoreKey: this.restoreKey};

                        this.bluetoothle.initialize(params).subscribe(result => {
                            console.debug("[BluetoothLE] Initialization result: " + JSON.stringify(result));
                        });
                        //Use this way because the issue iOS: initialize promise resolve not called #477
                        setTimeout(() => {
                            this.btEnabled$.next(true);
                        }, 10000);

                    });

                    this.btEnabled$.subscribe(enabled => {
                        if (enabled) {
                            this.startScan();
                            this.startAdvertising();
                        }
                    })
                }
            });

        } else {
            this.permissionsService.goToNextPermissionIfPermissionsRequested();
        }

         */

        return this.btEnabled$;

    }

    protected prepareBackgroundMode() {
        App.addListener('appStateChange', (state) => {

            if (!state.isActive) {

                // The app has become inactive. We should check if we have some work left to do, and, if so,
                // execute a background task that will allow us to finish that work before the OS
                // suspends or terminates our app:
                let taskId = BackgroundTask.beforeExit(async () => {

                    this.startScanningInBackgroundMode();
                    if(!this.isAdvertising) {
                        this.startAdvertising();
                    }

                    BackgroundTask.finish({
                        taskId
                    });

                });
                this.backgroundMode = true;

            }
            else {
                if(this.backgroundMode) {
                    this.startScanningInForegroundMode();
                }
                this.backgroundMode = false;
            }

        });
    }


    protected addService() {

        console.debug("[BluetoothLE] Add service with UUID: " + this.patientServiceUUID);

        let returnValue: Subject<boolean> = new Subject();

        let params = {
            service: BluetoothTrackingService.serviceUUID,
            characteristics: [
                {
                    uuid: this.patientServiceUUID,
                    permissions: {
                        read: true,
                        write: true,
                    },
                    properties : {
                        read: true,
                        writeWithoutResponse: true,
                        write: true,
                        notify: true,
                        indicate: true
                    }
                }
            ]
        };

        this.bluetoothle.addService(params).then(result => {
            console.debug('[BluetoothLE] addService result: ' + JSON.stringify(result));
            returnValue.next(true);
        })
            .catch(error => {
                console.error('[BluetoothLE] addService error: ' + JSON.stringify(error));
                returnValue.next(false);
            });

        return returnValue;
    }

    public startAdvertising() {

        if(!this.isAdvertising) {
            this.isAdvertising = true;

            console.debug("[BluetoothLE] start advertise ...");

            let params = {
                "request": true, //Should user be prompted to enable Bluetooth
                "restoreKey": this.restoreKey
            };

            this.bluetoothle.initializePeripheral(params).subscribe(result => {

                if (result.status == 'enabled') {

                    this.addService().subscribe(result => {

                        if (result) {

                            let params = {
                                "services": [BluetoothTrackingService.serviceUUID], //iOS
                                "service": BluetoothTrackingService.serviceUUID, //Android
                                "name": "Open Coronavirus",
                                "includeDeviceName": false,
                                "mode": 'balanced',
                                "connectable": true,
                                "timeout": 0,
                            };

                            this.bluetoothle.startAdvertising(params).then(result => {
                                console.debug("[BluetoothLE] Started advertising: " + JSON.stringify(result));
                            })
                                .catch(error => {
                                    console.error("[BluetoothLE] Error trying to advertise: " + JSON.stringify(error));
                                })
                        }

                    });

                }

            });
        }

    }

    public startScan(backgroundMode = false) {

        if (!this.isScanning) {

            this.isScanning = true;

            if (backgroundMode) {
                console.debug("[BluetoothLE] Start scanning in background mode ...");
            } else {
                console.debug("[BluetoothLE] Start scanning ...");
            }

            this.ble.startScan([BluetoothTrackingService.serviceUUID]).subscribe(device => {

                if (!this.contactTrackerService.isKnownContact(device.id)) {
                    //avoid duplicate calls while processing an item (because this is a subscription callback from ble.scan method
                    console.debug('[BluetoothLE] connecting to ' + device.id + " ...");
                    this.ble.connect(device.id).subscribe(result => {
                        console.debug('[BluetoothLE] connected result: ' + JSON.stringify(result));



                        result.characteristics.forEach(characteristic => {
                            if (characteristic.service.toUpperCase() == BluetoothTrackingService.serviceUUID) {
                                let targetCharacteristicUUID = characteristic.characteristic;
                                console.debug("**********************************************************************************************");
                                console.debug("    Open Coronavirus Target service detected: " + targetCharacteristicUUID + ", rssi: " + device.rssi);
                                console.debug("**********************************************************************************************");
                                //now save the device, with the address and so on into local storage
                                if (!this.addressesBeingTracked.has(device.id)) {
                                    this.addressesBeingTracked.set(device.id, true);
                                    //this.contactTrackerService.trackContact(targetCharacteristicUUID, device.rssi, device.id);
                                }
                            }
                        });
                        this.ble.disconnect(device.id); //disconnect from the device!!! so important
                    },
                    peripheralData => {
                        console.error('[BluetoothLE] error connecting: ' + JSON.stringify(peripheralData));
                    });
                } else {
                    this.contactTrackerService.updateTrack(device.id, device.rssi);
                }

            });

            if (!backgroundMode) {
                this.scanTimeout = setTimeout(() => {
                    this.stopScan(backgroundMode);
                }, BluetoothTrackingService.timeScanningInMillis);
            }
        }

    }

    public stopScan(backgroundMode = false) {
        let returnValue: Promise<boolean> = new Promise(resolve => {

            this.isScanning = false;
            if (backgroundMode) {
                console.debug("[BluetoothLE] Stop scanning in background mode ...");
            } else {
                console.debug("[BluetoothLE] Stop scanning ...");
            }
            this.ble.stopScan().then(result => {
                console.log('[BluetoothLE] Stop scanning successfully!');
                resolve(true);
            })
                .catch(error => {
                    console.error('[BluetoothLE] Error trying to stop scanning: ' + JSON.stringify(error));
                    resolve(false);
                })
                .finally(() => {
                    if (!backgroundMode) {
                        this.scanTimeout = setTimeout(() => {
                            this.startScan(backgroundMode);
                        }, BluetoothTrackingService.timeWithoutScanningInMillis);
                    }
                })
        });

        return returnValue;
    }

    public startScanningInBackgroundMode() {
        if(this.scanTimeout != null) {
            clearTimeout(this.scanTimeout);
        }
        if(this.isScanning) { //always stop if scanning in order to start in background mode
            this.stopScan(true).then(result => {
                this.startScan(true);
            });
        }
        this.startScan(true);
    }

    public startScanningInForegroundMode() {
        if(this.isScanning) {
            this.stopScan(true);
        }
        this.startScan();
    }




}
