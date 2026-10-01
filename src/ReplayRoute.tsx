import { LabReplay } from './LabReplay';
import labRecordingExample from './data/lab-recording-example.json?raw';

export function ReplayRoute() {
  return <LabReplay exampleJson={labRecordingExample} />;
}
