export interface MotionProfile {
  readonly id: string
  readonly label: string
  readonly metersPerSecond: number
}

export interface MotionProfileSet {
  readonly defaultProfileId: string
  readonly profiles: ReadonlyArray<MotionProfile>
}

export const motionProfileFor = (profileSet: MotionProfileSet, profileId: string): MotionProfile => {
  const profile = profileSet.profiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`unknown motion profile: ${profileId}`)
  return profile
}

export const defaultMotionProfile = (profileSet: MotionProfileSet): MotionProfile =>
  motionProfileFor(profileSet, profileSet.defaultProfileId)
