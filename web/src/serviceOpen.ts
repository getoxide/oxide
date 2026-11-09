/** A one-shot request from the sidebar to open a Project Service's log tab in the Terminal Surface. */
export interface OpenServiceRequest {
  projectId: number;
  serviceId: number;
  /** Distinguishes repeat clicks on the same service, so #406 treats each as a new request. */
  token: number;
}
