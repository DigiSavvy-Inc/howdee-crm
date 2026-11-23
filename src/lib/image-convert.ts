// The implementation lives in @digisavvy/block-editor (#558); this shim keeps `$lib/image-convert` imports working.
export {
	AVIF_CONVERT_ERROR,
	AVIF_CONVERT_ERROR_NO_JPEG,
	convertFileInput,
	isAvif,
	prepareImageForUpload
} from '@digisavvy/block-editor/blocks';
