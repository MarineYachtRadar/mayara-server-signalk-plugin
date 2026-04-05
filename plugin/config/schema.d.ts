import { Static } from '@sinclair/typebox';
export declare const ConfigSchema: import("@sinclair/typebox").TObject<{
    managedContainer: import("@sinclair/typebox").TBoolean;
    mayaraVersion: import("@sinclair/typebox").TString;
    mayaraArgs: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    host: import("@sinclair/typebox").TString;
    port: import("@sinclair/typebox").TNumber;
    secure: import("@sinclair/typebox").TBoolean;
    discoveryPollInterval: import("@sinclair/typebox").TNumber;
    reconnectInterval: import("@sinclair/typebox").TNumber;
}>;
export type Config = Static<typeof ConfigSchema>;
//# sourceMappingURL=schema.d.ts.map