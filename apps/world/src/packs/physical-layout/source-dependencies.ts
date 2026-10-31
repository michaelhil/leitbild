export interface PhysicalSourceDependency { readonly role:string; readonly sourceId:string; readonly physicalSourceDigest:string; readonly physicalShapeDigest:string }
/** A derived layout cannot silently acknowledge a different source merely by
 * updating its catalog dependency pin. Re-author the dependent geometry first. */
export const physicalSourceDependencyFailure=(witnesses:ReadonlyArray<PhysicalSourceDependency>,actual:ReadonlyArray<PhysicalSourceDependency>):string|null=>{
 for(const member of actual)if(!witnesses.some(witness=>witness.role===member.role))return`Derived physical source dependency mismatch: ${member.role} has no authored source/shape witness; re-author the dependent physical geometry before repinning`
 for(const witness of witnesses){const values=actual.filter(value=>value.role===witness.role);if(values.length!==1||values[0]!.sourceId!==witness.sourceId||values[0]!.physicalSourceDigest!==witness.physicalSourceDigest||values[0]!.physicalShapeDigest!==witness.physicalShapeDigest)return`Derived physical source dependency mismatch: ${witness.role} requires its authored source facts and compiled shape; re-author the dependent physical geometry before repinning`}
 return null
}
